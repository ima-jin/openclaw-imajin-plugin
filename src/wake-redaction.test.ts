import { describe, expect, it } from "vitest";
import { redactWakeText } from "./wake-redaction.js";
import { WakeGuards, type WakeGuardAlert } from "./wake-guards.js";

describe("wake alert redaction", () => {
  it.each([
    "ghp_fixture123", "gho_fixture123", "ghs_fixture123", "github_pat_fixture123",
    "sk-fixture-123", "xoxa-fixture-123", "xoxb-fixture-123", "xoxp-fixture-123",
    "Bearer fixture123", "eyJfixture.payload.signature",
    "-----BEGIN PRIVATE KEY-----\nfixture-secret\n-----END PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-secret\n-----END OPENSSH PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nfixture-secret",
  ])("masks credential-shaped text %j", (text) => {
    expect(redactWakeText(`before ${text} after`)).not.toContain(text);
    expect(redactWakeText(text)).toContain("[redacted]");
  });

  it.each(["token", "SECRET", "password", "authorization", "api_key", "api-key", "cookie",
    "credential", "private_key", "private-key", "claim_code", "claim-code", "hookToken"])(
    "redacts structured %s values in args and result", async (key) => {
      let evidence: WakeGuardAlert | undefined;
      const guards = new WakeGuards({
        alert: async (batch) => { evidence = batch; }, abort: async () => {},
        reportTo: [{ sessionKey: "agent:main:telegram:direct:123" }],
      });
      const ctx = { sessionKey: "agent:main:wake:redaction", runId: "runner" };
      guards.track({ batchId: "wake", sessionKey: ctx.sessionKey, subject: "review", uniqueSession: true });
      await guards.afterToolCall({
        toolName: "exec", params: { nested: [{ [key]: "fixture-args-private" }] },
        result: { content: [{ type: "text", text: JSON.stringify({ [key]: "fixture-result-private" }) }] },
      }, ctx);
      await guards.end({ messages: [{ role: "assistant", content: "NO_REPLY" }] }, ctx);
      expect(JSON.stringify(evidence)).not.toContain("fixture-args-private");
      expect(JSON.stringify(evidence)).not.toContain("fixture-result-private");
      expect(evidence?.lastTool?.args).toContain("[redacted]");
      expect(evidence?.lastTool?.result).toContain("[redacted]");
    },
  );

  it("redacts env assignments, assistant lines and tokens longer than the alert preview", () => {
    expect(redactWakeText('TOKEN=fixture123 API_KEY="fixture456"')).not.toContain("fixture");
    expect(redactWakeText("ghp_" + "x".repeat(2_000))).toBe("[redacted]");
    expect(redactWakeText("normal output: successful")).toBe("normal output: successful");
  });
});
