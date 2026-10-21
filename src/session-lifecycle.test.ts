import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSessionCommandBody, createSessionCommandAttester, createSessionCommandExecutor,
  isSessionCommandFrame, signSessionCommandBody, type SessionCommandFrame, type SessionCommandType,
} from "./session-commands.js";
import { createSessionGateway, type GatewaySession } from "./session-command-gateway.js";
import { createLoopTracker } from "./loop-tracker.js";
import { createSessionInventory } from "./session-inventory.js";
import type { LoopTransition } from "./loop-publisher.js";
import { verifyMessage } from "./approval-bridge.js";

const agent = "did:imajin:test-agent";
const principal = "did:imajin:test-owner";
const issuer = "did:imajin:test-kernel";
const now = Date.parse("2026-10-21T12:00:00Z");
const kernelKey = randomBytes(32).toString("hex");
const ownerKey = randomBytes(32).toString("hex");
const agentKey = randomBytes(32).toString("hex");
let kernelPublicKeyHex: string;
let ownerPublicKeyHex: string;
let agentPublicKeyHex: string;
let keypairPath: string;
let sequence = 0;
const newTypes = ["session.archive", "session.reset", "session.label", "session.history"] as const;

async function frame(type: SessionCommandType, payload: unknown, overrides: Partial<SessionCommandFrame> = {}) {
  const command: SessionCommandFrame = {
    type, payload, commandId: `command-${++sequence}`, to: agent, principal, issuer,
    issuedAt: new Date(now - 1000).toISOString(), ...overrides,
  };
  command.signature = await signSessionCommandBody(buildSessionCommandBody(command), kernelKey);
  command.countersignature = await signSessionCommandBody(buildSessionCommandBody(command), ownerKey);
  return command;
}

beforeAll(async () => {
  const probe = await frame("session.archive", {});
  kernelPublicKeyHex = (probe.signature as { keyId: string }).keyId;
  ownerPublicKeyHex = (probe.countersignature as { keyId: string }).keyId;
  agentPublicKeyHex = (await signSessionCommandBody(buildSessionCommandBody(probe), agentKey)).keyId;
  keypairPath = join(await mkdtemp(join(tmpdir(), "session-lifecycle-")), "keypair.json");
  await writeFile(keypairPath, JSON.stringify({ privateKey: agentKey }));
});

function setup(auth?: { serviceOf: string[] | null }) {
  const rows: GatewaySession[] = [{ key: "agent:main:dashboard", sessionId: "native-1", label: "Dashboard", updatedAt: now }];
  const events: LoopTransition[] = [];
  const tracker = createLoopTracker({ did: agent, emit: (event) => events.push(event) });
  tracker.onSessionSnapshot(rows[0]);
  const loopId = tracker.lookupSession(rows[0].key)!.loopId;
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.list") return { sessions: structuredClone(rows) };
    if (method === "chat.history") return { messages: [{ role: "user", content: "recent turn" }] };
    if (method === "sessions.patch") Object.assign(rows.find((s) => s.key === params.key)!, params);
    return {};
  });
  const gateway = createSessionGateway(request, ["operator.write", "operator.approvals"]);
  const inventory = createSessionInventory({ gateway, tracker, sender: { publish: vi.fn(), idle: async () => {} } });
  const ws = { send: vi.fn((_frame: any) => {}) };
  const executor = createSessionCommandExecutor({ agentDid: agent, kernelDid: issuer, kernelPublicKeyHex, allowedPrincipal: principal }, {
    gateway, loopTracker: tracker, publishHistory: inventory.history, refreshInventory: inventory.refresh,
    attest: createSessionCommandAttester({ did: agent, keypairPath, send: ws.send }),
    resolveServiceOf: async () => auth ? auth.serviceOf : [principal], resolvePublicKey: async () => ownerPublicKeyHex,
    now: () => now, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  });
  const handle = (command: SessionCommandFrame) => {
    expect(isSessionCommandFrame(command)).toBe(true);
    return executor.handleFrame(command); // same dispatch as the kernel WS handler
  };
  return { rows, events, loopId, request, gateway, tracker, inventory, ws, handle };
}

describe("signed lifecycle/history commands over the fake kernel WS", () => {
  it("archives both active views, retains the row/history and attests the mutation", async () => {
    const h = setup();
    expect(await h.handle(await frame("session.archive", { loopId: h.loopId }))).toMatchObject({ ok: true });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ sessionId: "native-1", archived: true });
    expect(h.tracker.resolveLoop(h.loopId)).toBeUndefined();
    expect(h.events).toContainEqual(expect.objectContaining({ type: "loop.finished", state: "archived", loopId: h.loopId, label: "Dashboard" }));
    expect(h.request.mock.calls.some(([method]) => method === "sessions.delete")).toBe(false);
    const attestation = h.ws.send.mock.calls[0][0].attestation;
    expect(attestation.payload).toMatchObject({ command: "session.archive", outcome: "completed", loopId: h.loopId });
    expect(await verifyMessage(attestation, agentPublicKeyHex)).toBe(true);
    expect(JSON.stringify(attestation.payload)).not.toContain("agent:main:dashboard");
  });

  it("relabels the Gateway, publishes the new label and signs its completion", async () => {
    const h = setup();
    expect(await h.handle(await frame("session.label", { loopId: h.loopId, label: "Renamed" }))).toMatchObject({ ok: true });
    await h.inventory.refresh();
    expect(h.rows[0].label).toBe("Renamed");
    expect(h.events).toContainEqual(expect.objectContaining({ label: "Renamed" }));
    expect(h.ws.send.mock.calls[0][0].attestation.payload).toMatchObject({ command: "session.label", outcome: "completed" });
  });

  it("attests reset's scope rejection without executing any admin RPC", async () => {
    const h = setup();
    expect(await h.handle(await frame("session.reset", { loopId: h.loopId }))).toMatchObject({ ok: false, reason: "missing_scope" });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.ws.send.mock.calls[0][0].attestation.payload).toMatchObject({
      outcome: "failed", reason: "missing_scope", detail: expect.stringContaining("operator.admin"),
    });
  });

  it("keeps reset registered but refuses it with a verifiable signed missing_scope on production scopes (#115)", async () => {
    const h = setup();
    expect(isSessionCommandFrame({ type: "session.reset" })).toBe(true);
    expect(await h.handle(await frame("session.reset", { loopId: h.loopId }))).toMatchObject({ ok: false, reason: "missing_scope" });
    expect(h.rows[0].sessionId).toBe("native-1");
    expect(h.tracker.resolveLoop(h.loopId)).toBeDefined();
    expect(h.request).not.toHaveBeenCalled();
    const attestation = h.ws.send.mock.calls[0][0].attestation;
    expect(attestation.payload).toMatchObject({ command: "session.reset", outcome: "failed", reason: "missing_scope" });
    expect(await verifyMessage(attestation, agentPublicKeyHex)).toBe(true);
  });

  it("publishes typed history on a signed open request", async () => {
    const h = setup();
    expect(await h.handle(await frame("session.history", { loopId: h.loopId }))).toMatchObject({ ok: true });
    expect(h.events.at(-1)?.output).toEqual({ kind: "text", role: "user", text: "recent turn" });
  });

  it.each(newTypes)("%s rejects and signs every authentication and target boundary", async (type) => {
    for (const rejection of ["unsigned", "expired", "not_yet_valid", "misaddressed", "issuer_mismatch", "principal_mismatch", "not_service_of", "service_binding_unverifiable", "invalid_signature", "missing_countersignature", "invalid_countersignature", "loop_not_found"] as const) {
      const h = setup(rejection === "not_service_of" ? { serviceOf: [] }
        : rejection === "service_binding_unverifiable" ? { serviceOf: null } : undefined);
      const overrides: Partial<SessionCommandFrame> = {};
      if (rejection === "expired") overrides.issuedAt = new Date(now - 600_000).toISOString();
      if (rejection === "not_yet_valid") overrides.issuedAt = new Date(now + 120_000).toISOString();
      if (rejection === "misaddressed") overrides.to = "did:imajin:other";
      if (rejection === "issuer_mismatch") overrides.issuer = "did:imajin:other";
      if (rejection === "principal_mismatch") overrides.principal = "did:imajin:other";
      const command = await frame(type, { loopId: rejection === "loop_not_found" ? "unknown" : h.loopId, ...(type === "session.label" ? { label: "New" } : {}) }, overrides);
      if (rejection === "unsigned") delete command.signature;
      if (rejection === "missing_countersignature") delete command.countersignature;
      if (rejection === "invalid_signature") command.signature = await signSessionCommandBody(buildSessionCommandBody(command), ownerKey);
      if (rejection === "invalid_countersignature") command.countersignature = await signSessionCommandBody(buildSessionCommandBody(command), kernelKey);
      expect(await h.handle(command)).toMatchObject({ ok: false, reason: rejection });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.ws.send).toHaveBeenCalledOnce();
      expect(h.ws.send.mock.calls[0][0].attestation.payload).toMatchObject({ outcome: "failed", reason: rejection });
    }
  });

  it.each(newTypes)("%s rejects malformed payloads and attempts to supply harness keys or extra mutations", async (type) => {
    for (const payload of [null, [], { loopId: "" }, { loopId: "x".repeat(257) }, { sessionKey: "k" }, { loopId: "x", archived: false }, { loopId: "x", sessionKey: "k" }]) {
      const h = setup();
      expect(await h.handle(await frame(type, payload))).toMatchObject({ ok: false, reason: "invalid_payload" });
      expect(h.request).not.toHaveBeenCalled();
    }
  });

  it.each(["", " ", "x".repeat(257), null, 1])("rejects invalid labels (%j)", async (label) => {
    const h = setup();
    expect(await h.handle(await frame("session.label", { loopId: h.loopId, label }))).toMatchObject({ ok: false, reason: "invalid_payload" });
    expect(h.request).not.toHaveBeenCalled();
  });

  it.each(["session.archive", "session.label", "session.history"] as const)("%s rejects a stale registry target missing on the Gateway", async (type) => {
    const h = setup();
    h.rows.length = 0;
    expect(await h.handle(await frame(type, { loopId: h.loopId, ...(type === "session.label" ? { label: "New" } : {}) })))
      .toMatchObject({ ok: false, reason: "session_not_found" });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(["sessions.list"]);
  });

  it("rejects replayed lifecycle wishes and never mutates twice", async () => {
    const h = setup();
    const command = await frame("session.label", { loopId: h.loopId, label: "New" });
    await h.handle(command);
    expect(await h.handle(command)).toMatchObject({ ok: false, reason: "replayed" });
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.patch")).toHaveLength(1);
  });
});
