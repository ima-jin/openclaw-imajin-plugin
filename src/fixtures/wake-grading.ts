import { vi } from "vitest";
import type { GradingPr, WakeGradingSource } from "../wake-grading.js";

export const GRADING_PR_URL = "https://github.com/fixture/repo/pull/101";
export const GRADING_HEAD = "a".repeat(40);
export function gradingFixture() {
  const pr: GradingPr = {
    id: "PR_fixture101", headSha: GRADING_HEAD,
    closingIssues: [{ repo: "fixture/repo", number: 101 }],
    reviews: [{ reviewer: "imajin-jin", state: "COMMENTED", commitSha: GRADING_HEAD }],
  };
  const source = {
    pullRequest: vi.fn(() => Promise.resolve(structuredClone(pr))),
    issue: vi.fn<WakeGradingSource["issue"]>((ref) => Promise.resolve({
      ...ref, body: ref.number === 101 ? "OUTCOME (inherited) · child outcome" : "OUTCOME · the epic yardstick",
      comments: ["DECISION ruled 2026-10-20 · do not redefine middle", "ordinary comment"],
      parent: ref.number === 101 ? { repo: "fixture/epics", number: 82 } : null,
      epic: ref.number === 82,
    })),
  };
  return { source, pr };
}
