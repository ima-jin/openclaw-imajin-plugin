import { afterEach, describe, expect, it, vi } from "vitest";
import { gateDecisionMutation } from "./wake-merge-gate.js";
import { resolveWakeGrading } from "./wake-grading.js";
import { gradingFixture, GRADING_HEAD, GRADING_PR_URL as PR } from "./fixtures/wake-grading.js";
import type { WakeToolEvent } from "./wake-decision.js";

const exec = (command: string): WakeToolEvent => ({ toolName: "exec", params: { command } });
const query = (verb = "enqueuePullRequest", id = "PR_fixture101") =>
  `mutation { ${verb}(input: {pullRequestId: "${id}"}) {clientMutationId} }`;
const graph = (verb?: string) => exec(`gh api graphql -f 'query=${query(verb)}'`);
const approve = exec(`gh pr review ${PR} --approve --body 'Evidence: checked'`);
const mcp = (toolName: string, params = {}): WakeToolEvent => ({
  toolName, params: { owner: "fixture", repo: "repo", pullNumber: 101, ...params },
});
const actions = [
  approve,
  mcp("mcp__github__create_pull_request_review", { event: "APPROVE", body: "checked" }),
  mcp("mcp__github__pull_request_review_write", { method: "submit", event: "APPROVE" }),
];
const merges = [exec(`gh pr merge ${PR} --squash`), graph(), graph("mergePullRequest"),
  mcp("mcp__github__merge_pull_request"), mcp("mcp__github__enqueue_pull_request"),
  mcp("mcp__github__merge_pull_request_review", { event: "APPROVE" }),
  mcp("mcp__github__pull_request_write", { method: "merge" }),
  mcp("mcp__github__pull_request_write", { action: "enqueue" }),
  mcp("mcp__github__graphql", { query: query() })];
async function fixture() {
  const { pr, source } = gradingFixture();
  const block = await resolveWakeGrading(PR, source);
  return { pr, source, block, gate: (event: WakeToolEvent) => gateDecisionMutation(event, [block], source, "/usr/bin/gh") };
}

afterEach(() => vi.useRealTimers());
describe("decision-child merge-side permission boundary (#101)", () => {
  it.each(actions)("blocks without a ticket grading block: $toolName $params", async (event) => {
    const { source } = gradingFixture();
    expect(await gateDecisionMutation(event, undefined, source, "/usr/bin/gh")).toMatchObject({ block: true });
    expect(source.pullRequest).not.toHaveBeenCalled();
  });

  it.each(merges)("never authorizes wake merge/enqueue, even with a resolved block: $toolName", async (event) => {
    const { gate, source } = await fixture();
    source.pullRequest.mockClear();
    expect(await gate(event)).toMatchObject({ block: true, blockReason: expect.stringContaining("wake paths never merge or enqueue") });
    expect(source.pullRequest).not.toHaveBeenCalled();
  });

  it.each(actions)("blocks standing current-head CHANGES_REQUESTED: $toolName $params", async (event) => {
    const { pr, gate } = await fixture();
    pr.reviews.push({ reviewer: "imajin-jin", state: "CHANGES_REQUESTED", commitSha: GRADING_HEAD },
      { reviewer: "imajin-jin", state: "APPROVED", commitSha: GRADING_HEAD });
    expect(await gate(event)).toMatchObject({ block: true, blockReason: expect.stringContaining("stands") });
  });

  it.each(actions)("allows a freshly graded new head, even with an old-head change request: $toolName $params", async (event) => {
    const { pr, source } = gradingFixture();
    pr.reviews.push({ reviewer: "imajin-jin", state: "CHANGES_REQUESTED", commitSha: GRADING_HEAD });
    pr.headSha = "b".repeat(40);
    const block = await resolveWakeGrading(PR, source);
    expect((await gateDecisionMutation(event, [block], source, "/usr/bin/gh"))?.block).not.toBe(true);
  });

  it("prefixes CLI and MCP approval bodies with the exact epic/DECISION/head yardstick", async () => {
    const { gate } = await fixture();
    const marker = `Graded against: OUTCOME fixture/epics#82 · DECISION fixture/repo#101, fixture/epics#82 @ ${GRADING_HEAD}`;
    expect((await gate(approve))?.params?.command).toContain(`'${marker}\n\nEvidence: checked'`);
    const result = await gate(mcp("create_pull_request_review", { event: "APPROVE", body: "live evidence" }));
    expect(result?.params?.body).toBe(`${marker}\n\nlive evidence`);
  });

  it("does not let a later approval clear current-head changes; a foreign review does not veto", async () => {
    const { pr, gate } = await fixture();
    pr.reviews = [{ reviewer: "someone-else", state: "CHANGES_REQUESTED", commitSha: GRADING_HEAD }];
    expect((await gate(approve))?.block).not.toBe(true);
  });

  it.each(["stale-head", "lookup", "unresolved", "wrong-pr", "wrong-node"])("fails closed on %s", async (failure) => {
    const { pr, block, source, gate } = await fixture();
    if (failure === "stale-head") pr.headSha = "b".repeat(40);
    if (failure === "lookup") source.pullRequest.mockRejectedValue(new Error("private diagnostics"));
    if (failure === "unresolved") block.resolved = false;
    if (failure === "wrong-pr") block.url = PR + "1";
    if (failure === "wrong-node") pr.id = "PR_other";
    const result = await gate(approve);
    expect(result).toMatchObject({ block: true });
    expect(JSON.stringify(result)).not.toContain("private diagnostics");
  });

  it.each([
    `gh pr review 101 --approve`, `gh pr review ${PR} --approve --body-file /tmp/body`,
    `gh pr review ${PR} --approve --body=x -b y`, `gh pr review ${PR} --approve -bhidden`,
    `gh pr review ${PR} -abhidden`,
    `gh pr review ${PR} --approve --repo other/repo`, `gh pr review 101 --approve -R fixture/repo -R other/repo`,
    `gh pr merge ${PR}; gh pr merge https://github.com/other/repo/pull/2`,
    `gh pr merge ${PR}\ngh pr merge https://github.com/other/repo/pull/2`,
    `sh -c 'gh pr merge ${PR}'`, `gh pr merge $(cat /tmp/pr)`,
    `gh api graphql --input /tmp/mutation`, `gh api repos/fixture/repo/pulls/101/reviews -f event=APPROVE`,
    `gh api graphql --hostname evil.example -f 'query=${query()}'`,
    `gh api graphql -f 'query=${query("enqueuePullRequest", "PR_other")}'`,
    `gh api graphql -f 'query=${query()} ${query("mergePullRequest", "PR_other")}'`,
    `gh api graphql -f 'query=mutation { enqueuePullRequest(input: {pullRequestId: "PR_other", clientMutationId: "PR_fixture101"}) {clientMutationId} }'`,
  ])("refuses ambiguous targets, opaque inputs and shell programs: %s", async (command) => {
    const { gate } = await fixture();
    expect(await gate(exec(command))).toMatchObject({ block: true });
  });

  it("refuses env overrides and mismatched expected heads but supports explicit repo and configured CLI", async () => {
    const { gate } = await fixture();
    expect(await gate({ ...approve, params: { ...approve.params, env: {} } })).toMatchObject({ block: true });
    expect(await gate(exec(`gh pr merge ${PR} --match-head-commit ${"b".repeat(40)}`))).toMatchObject({ block: true });
    expect((await gate(exec(`gh pr review 101 --repo=fixture/repo -a --body=checked`)))?.block).not.toBe(true);
    expect((await gate(exec(`/usr/bin/gh pr review ${PR} --approve`)))?.block).not.toBe(true);
  });

  it("bounds live review lookup failures rather than waiting forever", async () => {
    const { source, gate } = await fixture();
    vi.useFakeTimers();
    source.pullRequest.mockReturnValue(new Promise(() => {}));
    const pending = gate(approve);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ block: true });
  });

  it("gates a configured CLI whose basename is not gh", async () => {
    const { source } = gradingFixture();
    expect(await gateDecisionMutation(exec(`/opt/github pr review ${PR} --approve`), undefined, source, "/opt/github"))
      .toMatchObject({ block: true });
  });

  it("leaves unrelated reads, non-approval reviews and non-wake tools alone", async () => {
    const { gate } = await fixture();
    for (const event of [exec(`gh pr view ${PR} --json headRefOid`), exec(`gh pr review ${PR} --request-changes`),
      mcp("create_pull_request_review", { event: "REQUEST_CHANGES" }), { toolName: "read", params: {} }]) {
      expect(gate(event)).toBeUndefined();
    }
  });
});

describe("1. GraphQL endpoint goes through the strict GraphQL check only", () => {
  const document = 'mutation{addPullRequestReview(input:{pullRequestId:"PR_fixture101",event:APPROVE}){clientMutationId}}';
  const endpoints = ["graphql", "/graphql", "https://api.github.com/graphql"];
  const methods = ["-X GET", "-XGET", "--method GET", "--method=GET", "-X POST", "--method=POST"];
  const commands = endpoints.flatMap((endpoint) => methods.flatMap((method) => [
    `gh api ${method} ${endpoint} -f 'query=${document}'`,
    `gh api ${endpoint} ${method} -f 'query=${document}'`,
    `gh api ${method} ${endpoint} -f 'query=query{viewer{login}}'`,
    `gh api ${endpoint} ${method} -f 'query=query{viewer{login}}'`,
  ]));

  it.each(commands)("1. GraphQL endpoint goes through the strict GraphQL check only: %s", async (command) => {
    const { gate } = await fixture();
    expect(await gate(exec(command))).toMatchObject({ block: true });
  });
});

describe("2. No headers or input file on the read-only path", () => {
  const header = "X-HTTP-Method-Override: PUT";
  const options = [
    `-H '${header}'`, `'-H${header}'`, `'-H=${header}'`,
    ...["header", "input"].flatMap((name) => {
      const value = name === "header" ? header : "/tmp/body";
      return Array.from({ length: name.length }, (_, index) => `--${name.slice(0, index + 1)}`)
        .flatMap((flag) => [`${flag} '${value}'`, `${flag}='${value}'`]);
    }),
  ];
  const commands = options.flatMap((option) => [
    `gh api -X GET repos/o/r/pulls/101/merge ${option}`,
    `gh api repos/o/r/pulls/101/merge ${option}`,
    `gh api -XGET repos/o/r/pulls/101/merge ${option} -f state=closed`,
    `gh api repos/o/r/pulls/101/merge --method=GET ${option}`,
  ]);

  it.each(commands)("2. No headers or input file on the read-only path: %s", async (command) => {
    const { gate } = await fixture();
    expect(await gate(exec(command))).toMatchObject({ block: true });
  });
});

describe("3. Mutation words anywhere refuse", () => {
  const documents = [
    'query{viewer{login}} mutation{mergePullRequest(input:{pullRequestId:"PR_fixture101"}){clientMutationId}}',
    '{viewer{login}} mutation M{enqueuePullRequest(input:{pullRequestId:"PR_fixture101"}){clientMutationId}}',
    'query{viewer{login}} MUTATION{mergePullRequest(input:{pullRequestId:"PR_fixture101"}){clientMutationId}}',
    '# comment\nmutation{mergePullRequest(input:{pullRequestId:"PR_fixture101"}){clientMutationId}}',
    'query{viewer{login}}\n# comment\nmutation{mergePullRequest(input:{pullRequestId:"PR_fixture101"}){clientMutationId}}',
    "query{viewer{...Rule}} fragment Rule on User { mutation { login } }",
    "query{viewer{...Rule}} fragment Rule on User { MUTATION { login } }",
    "query{viewer{login}}\n# mutation",
    "subscription{viewer{login}}",
    "query{viewer{login}} subscription S{viewer{login}}",
    "{viewer{login}} SUBSCRIPTION S{viewer{login}}",
    "query{viewer{...Rule}} fragment Rule on User { subscription { login } }",
  ];

  it.each(documents)("3. Mutation words anywhere refuse: %s", async (document) => {
    const { gate } = await fixture();
    expect(await gate(exec(`gh api graphql -f 'query=${document}'`))).toMatchObject({ block: true });
  });
});
