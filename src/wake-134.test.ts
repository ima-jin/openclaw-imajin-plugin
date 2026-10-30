import { describe, expect, it } from "vitest";
import { gradingFixture, GRADING_HEAD, GRADING_PR_URL as PR } from "./fixtures/wake-grading.js";
import { gradingMarker, resolveWakeGrading } from "./wake-grading.js";
import { gateDecisionMutation } from "./wake-merge-gate.js";

const exec = (command: string) => ({ toolName: "exec", params: { command } });

describe("production grading chain replays (#134)", () => {
  it.each([77, 78])("events#%s: cross-repo parents and the non-epic #1988 intermediate", async (number) => {
    const { source, pr } = gradingFixture();
    const refs = [
      { repo: "ima-jin/events", number: 76 },
      { repo: "ima-jin/imajin-ai", number: 2989 },
      { repo: "ima-jin/imajin-ai", number: 1988 },
      { repo: "ima-jin/imajin-ai", number: 1981 },
    ];
    pr.closingIssues = [refs[0]];
    source.issue.mockImplementation(async (ref) => {
      const index = refs.findIndex((entry) => entry.repo === ref.repo && entry.number === ref.number);
      return { ...ref, body: `OUTCOME · yardstick ${index}`, epic: index === 3,
        comments: index === 1 || index === 3 ? [`DECISION ruled b (Ryan 2026-10-27) · ruling ${index} — Jin`] : [],
        parent: refs[index + 1] ?? null };
    });
    const url = `https://github.com/ima-jin/events/pull/${number}`;
    const block = await resolveWakeGrading(url, source);
    expect(block.resolved).toBe(true);
    expect(source.issue.mock.calls.map(([ref]) => ref)).toEqual(refs);
    expect(block.text).toContain("Ancestor ima-jin/imajin-ai#1988");
    expect(block.decisions).toEqual(["ima-jin/imajin-ai#2989", "ima-jin/imajin-ai#1981"]);
    expect(block.text).toContain("DECISION ruled b (Ryan 2026-10-27) · ruling 1 — Jin");
    const body = "Reviewed `events` and $literal\nSecond line: no merge authority.";
    const result = await gateDecisionMutation(exec(`gh pr review ${url} --approve --body '${body}'`), [block], source, "/usr/bin/gh");
    expect(result?.block).not.toBe(true);
    expect(result?.params?.command).toContain(body);
    expect(result?.params?.command).toContain(`@ ${GRADING_HEAD}`);
    // The changes-requested path and subsequent reads from events#77 must not need approval authority.
    expect(gateDecisionMutation(exec(`gh pr review ${url} --request-changes --body '${body}'`), [], source, "/usr/bin/gh")).toBeUndefined();
    expect(gateDecisionMutation(exec(`gh pr view ${url} --json reviews`), [], source, "/usr/bin/gh")).toBeUndefined();
    expect(gateDecisionMutation(exec(`gh pr diff ${url}`), [], source, "/usr/bin/gh")).toBeUndefined();
  });

  it("imajin-ai#3160: #3155 and closed #1391 resolve explicitly without OUTCOME", async () => {
    const { source, pr } = gradingFixture();
    pr.closingIssues = [{ repo: "ima-jin/imajin-ai", number: 3155 }];
    source.issue.mockImplementation(async (ref) => ({
      ...ref, body: "Recorded decision reasoning, not an OUTCOME or a ruled line.", comments: [], epic: false,
      state: ref.number === 1391 ? "CLOSED" : "OPEN",
      parent: ref.number === 3155 ? { ...ref, number: 1391 } : null,
    }));
    const url = "https://github.com/ima-jin/imajin-ai/pull/3160";
    const block = await resolveWakeGrading(url, source);
    expect(block.resolved).toBe(true);
    for (const line of ["ima-jin/imajin-ai#3155: no OUTCOME", "ima-jin/imajin-ai#1391: no OUTCOME",
      "chain ended at closed ima-jin/imajin-ai#1391", "OUTCOME none on chain"]) expect(block.text).toContain(line);
    const marker = `Graded against: OUTCOME none on chain · DECISION none @ ${GRADING_HEAD}`;
    expect(gradingMarker(block)).toBe(marker);
    const result = await gateDecisionMutation(exec(`gh pr review ${url} --approve`), [block], source, "/usr/bin/gh");
    expect(result?.params?.command).toContain(marker);
  });

  it("keeps comment-only rulings and walks past an OUTCOME-less epic through the whole chain", async () => {
    const { source } = gradingFixture();
    source.issue.mockImplementation(async (ref) => ({
      ...ref, body: ref.number === 103 ? "OUTCOME · nearest available" : "", epic: ref.number === 102,
      comments: ref.number === 102 ? ["DECISION ruled c (Ryan 2026-10-30) · comment only — Jin"] : [],
      parent: ref.number < 103 ? { ...ref, number: ref.number + 1 } : null,
    }));
    const block = await resolveWakeGrading(PR, source);
    expect(block.resolved).toBe(true);
    expect(block.text).toContain("DECISION ruled c (Ryan 2026-10-30) · comment only — Jin");
    expect(gradingMarker(block)).toBe(`Graded against: OUTCOME fixture/repo#103 · DECISION fixture/repo#102 @ ${GRADING_HEAD}`);
  });

  it("uses a comment-only DECISION with the explicit no-OUTCOME approval marker", async () => {
    const { source } = gradingFixture();
    source.issue.mockImplementation(async (ref) => ({
      ...ref, body: "", comments: ["DECISION ruled a (Ryan 2026-10-30) · no outcome is defined — Jin"],
      parent: null, epic: false,
    }));
    const block = await resolveWakeGrading(PR, source);
    expect(block.resolved).toBe(true);
    expect(gradingMarker(block)).toBe(`Graded against: OUTCOME none on chain · DECISION fixture/repo#101 @ ${GRADING_HEAD}`);
  });
});

describe("literal gh command boundary (#134)", () => {
  it.each([
    `gh pr view ${PR} --json reviews`, `gh pr diff ${PR}`, `gh pr checks ${PR}`,
    "gh issue view 1391 --repo ima-jin/imajin-ai",
    "gh api repos/fixture/repo/pulls/101", "gh api repos/fixture/repo/pulls/101 -X GET",
    "gh api repos/fixture/repo/pulls/101 -XGET",
    "gh api repos/fixture/repo/issues -X GET -f state=closed",
    `gh api graphql -f 'query=query { viewer { login } }'`,
  ])("allows read-only gh without any ticket: %s", async (command) => {
    const { source } = gradingFixture();
    expect(await gateDecisionMutation(exec(command), undefined, source, "/usr/bin/gh")).toBeUndefined();
    expect(source.pullRequest).not.toHaveBeenCalled();
  });

  it.each([
    `gh pr review ${PR} --approve --body "$dynamic"`,
    `gh pr review ${PR} --approve --body "\`dynamic\`"`,
    `gh pr review ${PR} --approve --body 'unterminated`,
    `gh pr review ${PR} --approve --body-file /tmp/body`,
    `gh --repo fixture/repo pr merge 101`,
    "gh api repos/fixture/repo/pulls/101/merge -XPUT",
    "gh api repos/fixture/repo/pulls/101/reviews -fevent=APPROVE",
    "gh api repos/fixture/repo/pulls/101/merge -X GET --method PUT",
  ])("names unparseable commands rather than claiming grading is missing: %s", async (command) => {
    const { source } = gradingFixture();
    const block = await resolveWakeGrading(PR, source);
    const result = await gateDecisionMutation(exec(command), [block], source, "/usr/bin/gh");
    expect(result).toMatchObject({ block: true, blockReason: expect.stringContaining("command not parseable for the merge gate:") });
    expect(result?.blockReason).not.toContain("no resolved grading block");
  });

  it("round-trips a quoted apostrophe without evaluating shell metacharacters", async () => {
    const { source } = gradingFixture();
    const block = await resolveWakeGrading(PR, source);
    const command = `gh pr review ${PR} -a --body 'Reviewer'\\''s \`code\` costs $0\nChecked.'`;
    const result = await gateDecisionMutation(exec(command), [block], source, "/usr/bin/gh");
    expect(result?.params?.command).toContain("'\\''s `code` costs $0");
    expect(result?.block).not.toBe(true);
  });
});
