import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { createWakeGradingSource } from "./wake-grading.js";
import { GRADING_HEAD, GRADING_PR_URL } from "./fixtures/wake-grading.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const end = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _opts: unknown, callback: any) => {
    callback(null, JSON.stringify({ data: { repository: { pullRequest: {
      id: "PR_fixture101", headRefOid: GRADING_HEAD,
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
      reviews: { nodes: [], pageInfo: { hasNextPage: false } },
    } } } }));
    return { stdin: { end } };
  }) as any);
});
describe("grading GitHub CLI boundary", () => {
  it("uses only the configured absolute executable, bounded shell-free GraphQL over stdin", async () => {
    await createWakeGradingSource("/fixture/github").pullRequest(GRADING_PR_URL);
    expect(execFile).toHaveBeenCalledWith("/fixture/github", ["api", "graphql", "--input", "-"],
      expect.objectContaining({ shell: false, timeout: 5_000, maxBuffer: 512 * 1024 }), expect.any(Function));
    const request = JSON.parse(end.mock.calls[0][0]);
    expect(request.variables).toEqual({ owner: "fixture", name: "repo", number: 101, cursor: null });
    expect(request.query).toContain("closingIssuesReferences");
  });

  it.each(["relative-path", "cli-error", "graphql-error", "malformed-json"])("refuses %s", async (failure) => {
    if (failure !== "relative-path") vi.mocked(execFile).mockImplementation(((_file: unknown, _args: unknown, _opts: unknown, callback: any) => {
      callback(failure === "cli-error" ? new Error("fixture failure") : null,
        failure === "graphql-error" ? '{"errors":[{"message":"fixture failure"}]}' : "not json");
      return { stdin: { end } };
    }) as any);
    await expect(createWakeGradingSource(failure === "relative-path" ? "gh" : "/fixture/github")
      .pullRequest(GRADING_PR_URL)).rejects.toThrow();
    if (failure === "relative-path") expect(execFile).not.toHaveBeenCalled();
  });
});
