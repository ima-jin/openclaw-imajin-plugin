import { afterEach, describe, expect, it, vi } from "vitest";
import { createWakeGradingSource, resolveWakeGrading, gradingMarker } from "./wake-grading.js";
import { gradingFixture, GRADING_HEAD, GRADING_PR_URL } from "./fixtures/wake-grading.js";

afterEach(() => vi.useRealTimers());
describe("plugin-owned grading resolution (#101)", () => {
  it("keeps closing issues, cross-repo native ancestry, OUTCOME and body/comment rulings verbatim", async () => {
    const { source, pr } = gradingFixture();
    source.issue.mockImplementation(async (ref) => ({
      ...ref, body: ref.number === 101 ? "OUTCOME (inherited) · child" : "OUTCOME · epic",
      comments: ["DECISION ruled 2026-10-20 · middle is never redefined\nDECISION ruled 2026-10-21 · supersedes prior ruling"],
      epic: ref.number === 82, parent: ref.number === 101 ? { repo: "fixture/epics", number: 82 } : null,
    }));
    const block = await resolveWakeGrading(GRADING_PR_URL, source);
    expect(block.resolved).toBe(true);
    expect(block.pr).toEqual(pr);
    for (const text of ["closingIssuesReferences: fixture/repo#101", "Ancestor fixture/epics#82",
      "OUTCOME · epic", "DECISION ruled 2026-10-20 · middle is never redefined",
      "DECISION ruled 2026-10-21 · supersedes prior ruling", '"reviewer":"imajin-jin"',
      '"state":"COMMENTED"', `"commitSha":"${GRADING_HEAD}"`]) expect(block.text).toContain(text);
    expect(gradingMarker(block)).toBe(`Graded against: OUTCOME fixture/epics#82 · DECISION fixture/repo#101, fixture/epics#82 @ ${GRADING_HEAD}`);
  });

  it.each(["no-closing", "missing-parent", "no-outcome", "cycle", "lookup", "identity", "too-large"])(
    "marks %s unresolved, without exposing diagnostics", async (failure) => {
      const { source, pr } = gradingFixture();
      if (failure === "no-closing") pr.closingIssues = [];
      if (failure === "lookup") source.issue.mockRejectedValue(new Error("private diagnostics"));
      else if (failure !== "no-closing") source.issue.mockImplementation(async (ref) => ({
        ...ref, number: failure === "identity" ? 999 : ref.number,
        body: failure === "no-outcome" ? "" : "OUTCOME · " + (failure === "too-large" ? "x".repeat(140_000) : "child"),
        comments: [], epic: failure === "too-large", parent: failure === "cycle" ? ref : null,
      }));
      const block = await resolveWakeGrading(GRADING_PR_URL, source);
      expect(block.resolved).toBe(false);
      expect(block.text).toContain("UNRESOLVED:");
      expect(block.text).toContain("Report blocked");
      expect(block.text).not.toContain("private diagnostics");
    },
  );

  it("bounds a hanging source and does not turn late evidence into authority", async () => {
    vi.useFakeTimers();
    const { source } = gradingFixture();
    source.pullRequest.mockReturnValue(new Promise(() => {}));
    const pending = resolveWakeGrading(GRADING_PR_URL, source);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).resolved).toBe(false);
  });

  it("marks no DECISION as none rather than inventing parent rulings", async () => {
    const { source } = gradingFixture();
    source.issue.mockImplementation(async (ref) => ({ ...ref, body: "OUTCOME · epic", comments: [], epic: true, parent: null }));
    expect(gradingMarker(await resolveWakeGrading(GRADING_PR_URL, source))).toContain(" · DECISION none @ ");
  });
});

const page = (nodes: unknown[], next = false) => ({ nodes, pageInfo: { hasNextPage: next, endCursor: next ? "next" : null } });
const nativeRef = { number: 101, repository: { nameWithOwner: "fixture/repo" } };
describe("authenticated GitHub grading adapter", () => {
  function adapter() {
    const graphql = vi.fn(async (query: string, variables: Record<string, unknown>): Promise<any> => {
      if (query.includes("issue(number:")) return { repository: { issue: {
        ...nativeRef, title: "Epic: yardstick", body: "OUTCOME · epic", parent: null,
        labels: page([{ name: "epic" }]), comments: page([{ body: "DECISION ruled · exact" }]),
      } } };
      return { repository: { pullRequest: {
        id: "PR_fixture101", headRefOid: GRADING_HEAD,
        closingIssuesReferences: page([nativeRef]),
        reviews: variables.cursor ? page([{ author: { login: "imajin-jin" }, state: "CHANGES_REQUESTED", commit: { oid: GRADING_HEAD } }])
          : page([], true),
      } } };
    });
    return { graphql, source: createWakeGradingSource("/usr/bin/gh", graphql) };
  }

  it("paginates review history and requests native parents, comments and closingIssuesReferences", async () => {
    const { source, graphql } = adapter();
    const block = await resolveWakeGrading(GRADING_PR_URL, source);
    expect(block.resolved).toBe(true);
    expect(block.pr?.reviews[0].state).toBe("CHANGES_REQUESTED");
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("closingIssuesReferences"), {
      owner: "fixture", name: "repo", number: 101, cursor: null,
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("reviews"), expect.objectContaining({ cursor: "next" }));
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("parent { number repository"), expect.anything());
  });

  it.each(["missing-pr", "bad-head", "changing-head", "missing-page", "stuck-page", "bad-ref", "bad-review",
    "missing-issue", "labels-overflow", "bad-comment", "bad-parent"])("fails closed on %s", async (failure) => {
    const { graphql, source } = adapter();
    const implementation = graphql.getMockImplementation()!;
    graphql.mockImplementation(async (query, variables) => {
      const data = await implementation(query, variables);
      const pr = data.repository.pullRequest;
      const issue = data.repository.issue;
      if (pr) {
        if (failure === "missing-pr") data.repository.pullRequest = null;
        if (failure === "bad-head") pr.headRefOid = "";
        if (failure === "changing-head" && variables.cursor) pr.headRefOid = "b".repeat(40);
        if (failure === "missing-page") delete pr.reviews.pageInfo;
        if (failure === "stuck-page") pr.reviews = page([], true);
        if (failure === "bad-ref") pr.closingIssuesReferences = page([{}]);
        if (failure === "bad-review") pr.reviews = page([{}]);
      }
      if (issue) {
        if (failure === "missing-issue") issue.body = null;
        if (failure === "labels-overflow") issue.labels.pageInfo.hasNextPage = true;
        if (failure === "bad-comment") issue.comments = page([{}]);
        if (failure === "bad-parent") issue.parent = {};
      }
      return data;
    });
    expect((await resolveWakeGrading(GRADING_PR_URL, source)).resolved).toBe(false);
  });

  it("rejects an invalid PR URL before any GitHub request", async () => {
    const { source, graphql } = adapter();
    await expect(source.pullRequest("https://evil.example/repo/pull/101")).rejects.toThrow("Invalid PR URL");
    expect(graphql).not.toHaveBeenCalled();
  });
});
