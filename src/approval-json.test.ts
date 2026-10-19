import { describe, expect, it } from "vitest";
import { assertJsonStable } from "./approval-json.js";
import { buildApprovalRequestedPayload, buildDigestFields, computeContentHash, signCanonicalPayload } from "./gateway-approvals-bridge.js";

describe("approval JSON stability guard (#94)", () => {
  it.each([
    undefined, NaN, Infinity, -Infinity, 1n, Symbol("value"), () => {},
    new Date(), new Map(), new Set(), /test/, new Number(1),
    { nested: { value: undefined } }, [undefined], Array(1),
    Object.assign([1], { extra: 2 }),
    { [Symbol("key")]: "value" },
    Object.defineProperty({}, "hidden", { value: 1 }),
    Object.defineProperty({}, "getter", { enumerable: true, get: () => 1 }),
  ])("rejects non-JSON value %#", (value) => {
    expect(() => assertJsonStable(value)).toThrow(TypeError);
  });

  it("rejects cycles but permits repeated references to plain data", () => {
    const shared = { value: 1 };
    expect(() => assertJsonStable({ first: shared, second: shared })).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertJsonStable(cyclic)).toThrow(/acyclic/);
  });

  it("accepts every JSON primitive, arrays, and null-prototype records", () => {
    expect(() => assertJsonStable({
      nested: [null, "text", true, false, 0, -1, 1.5, { unicode: "é" }],
      empty: Object.create(null),
    })).not.toThrow();
  });

  it("refuses undefined revisions and nested values before digest construction or signing", async () => {
    const fields = { proposalId: "p", source: "test", kind: "test:update", summary: "Update", sourceRevision: "rev" };
    expect(() => buildDigestFields({ ...fields, sourceRevision: undefined as never })).toThrow(/JSON-stable/);
    expect(() => buildDigestFields({ ...fields, detail: { nested: [undefined] } })).toThrow(/JSON-stable/);
    await expect(buildApprovalRequestedPayload("test", {
      ...fields, detail: { bad: undefined },
    }, { did: "did:imajin:test", privateKeyHex: "01".repeat(32) })).rejects.toThrow(/JSON-stable/);
    await expect(computeContentHash({ bad: undefined })).rejects.toThrow(/JSON-stable/);
    await expect(signCanonicalPayload({ bad: undefined }, "01".repeat(32))).rejects.toThrow(/JSON-stable/);
  });
});
