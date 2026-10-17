import { describe, expect, it } from "vitest";
import { ApprovalExecutionRegistry } from "./approval-execution.js";

describe("ApprovalExecutionRegistry", () => {
  it("claims synchronously once across competing async rails", async () => {
    const registry = new ApprovalExecutionRegistry();
    const attempts = await Promise.all(Array.from({ length: 100 }, async () => registry.claim("native-id")));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(registry.claim("native-id")).toBe(false);
    expect(registry.claim("another-id")).toBe(true);
  });

  it("never evicts old claims after many later executions", () => {
    const registry = new ApprovalExecutionRegistry();
    registry.claim("old");
    for (let i = 0; i < 10_000; i++) expect(registry.claim(`later-${i}`)).toBe(true);
    expect(registry.claim("old")).toBe(false);
  });

  it("rejects empty ids without blocking a valid claim", () => {
    const registry = new ApprovalExecutionRegistry();
    expect(registry.claim("")).toBe(false);
    expect(registry.claim(" \n")).toBe(false);
    expect(registry.claim("valid")).toBe(true);
  });

  it("retains immutable bindings independently of execution claims", () => {
    const registry = new ApprovalExecutionRegistry();
    const binding = { approvalId: "a", loopId: "loop", agentDid: "did:agent", principalDid: "did:principal" };
    registry.bind(binding);
    registry.bind({ ...binding });
    binding.loopId = "mutated";
    expect(registry.getBinding("a")?.loopId).toBe("loop");
    expect(Object.isFrozen(registry.getBinding("a"))).toBe(true);
    expect(registry.getBinding("unknown")).toBeUndefined();
    expect(registry.claim("a")).toBe(true);
    registry.bind({ ...binding, loopId: "loop" });
    expect(registry.claim("a")).toBe(false);
  });

  it.each(["loopId", "principalDid", "agentDid"] as const)("rejects reassignment of %s", (field) => {
    const registry = new ApprovalExecutionRegistry();
    const binding = { approvalId: "a", loopId: "loop", agentDid: "did:agent", principalDid: "did:principal" };
    registry.bind(binding);
    expect(() => registry.bind({ ...binding, [field]: "different" })).toThrow("approval binding conflict");
    expect(registry.getBinding("a")).toEqual(binding);
  });
});
