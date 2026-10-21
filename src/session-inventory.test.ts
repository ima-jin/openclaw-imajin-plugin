import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize } from "./approval-bridge.js";
import { createLoopSender, type LoopIngestRequest } from "./loop-publisher.js";
import { createLoopTracker } from "./loop-tracker.js";
import { createSessionGateway, type GatewaySession } from "./session-command-gateway.js";
import { createSessionInventory } from "./session-inventory.js";

let keypairPath: string;
beforeAll(async () => {
  keypairPath = join(await mkdtemp(join(tmpdir(), "inventory-")), "identity.json");
  await writeFile(keypairPath, JSON.stringify({ privateKey: randomBytes(32).toString("hex") }));
});

function setup(statePath?: string) {
  const rows: GatewaySession[] = [
    { key: "agent:main:dashboard", sessionId: "dashboard-id", label: "Dashboard", updatedAt: 123 },
    { key: "agent:main:telegram:direct:42", sessionId: "telegram-id", label: "Telegram", updatedAt: 456 },
    { key: "agent:main:warp-events", sessionId: "warp-id", label: "Warp", updatedAt: 789 },
    { key: "agent:main:subagent:c", sessionId: "child-id" },
    { key: "agent:main:cron:job", sessionId: "cron-id" },
    { key: "agent:main:acp:worker", sessionId: "acp-id" },
    { key: "agent:main:custom-child", sessionId: "custom-child-id", spawnedBy: "agent:main:dashboard" },
  ];
  const requests: LoopIngestRequest[] = [];
  const sender = createLoopSender({
    did: "did:imajin:inventory", principal: "did:imajin:operator", keypairPath, nodeUrl: "https://kernel.invalid",
    fetchImpl: vi.fn(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  const tracker = createLoopTracker({ did: "did:imajin:inventory", emit: sender.publish });
  const messages: unknown[] = [
    { id: "turn-1", role: "user", content: "token=synthetic-private-value hello" },
    { id: "turn-2", role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { password: "synthetic-private-value" } }] },
    { id: "turn-3", role: "toolResult", toolCallId: "call", content: "done" },
  ];
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.list") return { sessions: structuredClone(rows) };
    if (method === "chat.history") return { messages: structuredClone(messages) };
    return {};
  });
  const gateway = createSessionGateway(request);
  const warn = vi.fn();
  const inventory = createSessionInventory({ gateway, tracker, sender, warn, statePath });
  return { rows, requests, request, gateway, tracker, sender, inventory, warn, messages };
}

describe("top-level session inventory", () => {
  it("resumes after the last emitted block when disposed during a multi-block backfill", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "inventory-partial-")), "sessions.json");
    const turn = { id: "multi-block", role: "assistant", content: [
      { type: "text", text: "first block" }, { type: "text", text: "second block" },
    ] };
    const first = setup(statePath);
    first.rows.splice(1);
    first.messages.splice(0, first.messages.length, turn);
    const publish = first.tracker.publishSessionOutput;
    vi.spyOn(first.tracker, "publishSessionOutput").mockImplementation((loopId, output) => {
      publish(loopId, output);
      first.inventory.dispose();
    });
    await first.inventory.refresh();
    await first.inventory.idle();
    expect(first.requests.filter((r) => r.payload.output)).toHaveLength(1);
    const second = setup(statePath);
    second.rows.splice(1);
    second.messages.splice(0, second.messages.length, turn);
    await second.inventory.refresh();
    await second.inventory.idle();
    const outputs = second.requests.filter((r) => r.payload.output);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].payload.output).toMatchObject({ text: "second block" });
    const loopId = second.tracker.lookupSession(second.rows[0].key)!.loopId;
    await Promise.all([second.inventory.history(loopId), second.inventory.history(loopId)]);
    expect(second.requests.filter((r) => r.payload.output)).toHaveLength(1);
  });
  it("persists unarchive before a later archive and does not replay either archived snapshot after restart", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "inventory-unarchive-")), "sessions.json");
    const first = setup(statePath);
    first.rows[0].archived = true;
    await first.inventory.refresh();
    await first.inventory.idle();
    first.inventory.dispose();
    const second = setup(statePath); // Same native row, explicitly unarchived.
    await second.inventory.refresh();
    await second.inventory.idle();
    expect(second.requests.filter((r) => r.type === "loop.finished")).toHaveLength(0);
    second.rows[0].archived = true;
    await second.inventory.refresh();
    await second.inventory.idle();
    expect(second.requests.filter((r) => r.type === "loop.finished")).toHaveLength(1);
    second.inventory.dispose();
    const third = setup(statePath);
    third.rows[0].archived = true;
    await third.inventory.refresh();
    await third.inventory.idle();
    expect(third.requests.filter((r) => r.type === "loop.finished")).toHaveLength(0);
  });

  it("fails closed on a corrupt checkpoint rather than re-emitting an entire transcript", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "inventory-corrupt-")), "sessions.json");
    await writeFile(statePath, "corrupt");
    const h = setup(statePath);
    await expect(h.inventory.refresh()).rejects.toThrow();
    expect(h.requests).toHaveLength(0);
    expect(h.request).not.toHaveBeenCalled();
  });
  it("persists per-session history/archive watermarks across two boots and emits only a new turn after restart", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "inventory-restart-")), "sessions.json");
    const archived = { key: "agent:main:archived", sessionId: "archived-id", archived: true };
    const first = setup(statePath);
    first.rows.push(archived);
    await first.inventory.refresh();
    await first.inventory.idle();
    expect(first.requests.filter((r) => r.payload.output)).toHaveLength(9);
    expect(first.requests.filter((r) => r.type === "loop.finished")).toHaveLength(1);
    first.inventory.dispose();

    const second = setup(statePath); // Fresh tracker, sender, store and Gateway client.
    second.rows.push(archived);
    await second.inventory.refresh();
    await second.inventory.idle();
    expect(second.requests.filter((r) => r.payload.output)).toHaveLength(0);
    expect(second.requests.filter((r) => r.type === "loop.finished")).toHaveLength(0);
    second.tracker.onSessionStart({ sessionKey: archived.key, sessionId: archived.sessionId });
    expect(second.tracker.lookupSession(archived.key)).toBeUndefined();
    second.gateway.history = vi.fn(async (key) => key === second.rows[0].key
      ? [...second.messages, { id: "turn-4", role: "assistant", content: "new after restart" }]
      : second.messages);
    second.inventory.onEvent({ event: "sessions.changed" });
    await second.inventory.refresh();
    await second.inventory.idle();
    const outputs = second.requests.filter((r) => r.payload.output);
    expect(outputs).toHaveLength(1);
    expect(outputs[0].payload.output).toEqual({ kind: "text", role: "assistant", text: "new after restart" });
    await second.inventory.history(second.tracker.lookupSession(second.rows[0].key)!.loopId);
    expect(second.requests.filter((r) => r.payload.output)).toHaveLength(1);
    second.inventory.dispose();

    const third = setup(statePath);
    third.rows.push(archived);
    third.gateway.history = second.gateway.history;
    await third.inventory.refresh();
    await third.inventory.idle();
    expect(third.requests.filter((r) => r.payload.output || r.type === "loop.finished")).toHaveLength(0);
  });

  it("starts a separate watermark for a new native sessionId on an already backfilled key", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "inventory-reset-")), "sessions.json");
    const first = setup(statePath);
    await first.inventory.refresh();
    await first.inventory.idle();
    first.inventory.dispose();
    const second = setup(statePath);
    second.rows[0].sessionId = "replacement-id";
    await second.inventory.refresh();
    await second.inventory.idle();
    expect(second.requests.filter((r) => r.payload.output)).toHaveLength(3);
  });
  it("publishes every inventory row and later changes without waiting for a stalled history request", async () => {
    const h = setup();
    let resolve!: (messages: unknown[]) => void;
    h.gateway.history = vi.fn().mockImplementationOnce(() => new Promise<unknown[]>((done) => { resolve = done; })).mockResolvedValue([]);
    await h.inventory.refresh();
    expect(h.requests.filter((r) => r.type === "loop.started")).toHaveLength(3);
    h.rows[2].label = "Changed during history";
    h.inventory.onEvent({ event: "sessions.changed" });
    await h.inventory.refresh();
    expect(h.requests).toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ label: "Changed during history" }),
    }));
    resolve([]);
    await h.inventory.idle();
  });
  it("publishes dashboard, Telegram and warp-events metadata plus redacted typed history at boot", async () => {
    const h = setup();
    h.inventory.onConnected();
    await vi.waitFor(() => expect(h.requests.filter((r) => r.payload.output)).toHaveLength(9));
    expect(h.request).toHaveBeenCalledWith("sessions.subscribe", {});
    const starts = h.requests.filter((r) => r.type === "loop.started");
    expect(starts.map((r) => r.payload.label)).toEqual(["Dashboard", "Telegram", "Warp"]);
    expect(starts.map((r) => r.payload.lastActivityAt)).toEqual([123, 456, 789]);
    for (const start of starts) {
      expect(start.payload).toMatchObject({ kind: "openclaw.session", agentId: "main", parentLoopId: null, blockedOnYou: false });
      expect(start.payload).not.toHaveProperty("sessionKey");
      expect(start.payload.refs.sessionKey).toBeDefined();
    }
    expect(h.requests.filter((r) => r.payload.output).slice(0, 3).map((r) => r.payload.output?.kind))
      .toEqual(["text", "tool_call", "tool_result"]);
    expect(JSON.stringify(h.requests)).not.toContain("synthetic-private-value");
    const ed = await import("@noble/ed25519");
    for (const request of h.requests) {
      expect(await ed.verifyAsync(
        Buffer.from(request.signature.sig, "hex"),
        new TextEncoder().encode(canonicalize({ type: request.type, payload: request.payload })),
        Buffer.from(request.signature.keyId, "hex"),
      )).toBe(true);
    }
  });

  it("immediately refreshes changed labels/activity, closes archives, and preserves parent lineage", async () => {
    const h = setup();
    await h.inventory.refresh();
    const parent = h.tracker.lookupSession(h.rows[0].key)!;
    h.tracker.onSubagentSpawned({ childSessionKey: "agent:main:subagent:new" }, { requesterSessionKey: h.rows[0].key });
    await h.sender.idle();
    expect(h.requests.at(-1)?.payload.parentLoopId).toBe(parent.loopId);
    h.rows[0].label = "Changed";
    h.rows[0].updatedAt = 999;
    h.inventory.onEvent({ event: "sessions.changed", payload: { reason: "update" } });
    await h.inventory.refresh();
    expect(h.requests).toContainEqual(expect.objectContaining({ payload: expect.objectContaining({
      loopId: parent.loopId, label: "Changed", lastActivityAt: 999,
    }) }));
    h.rows[0].archived = true;
    h.inventory.onEvent({ event: "sessions.changed" });
    await h.inventory.refresh();
    expect(h.requests).toContainEqual(expect.objectContaining({ type: "loop.finished", payload: expect.objectContaining({
      loopId: parent.loopId, state: "archived",
    }) }));
    expect(h.tracker.resolveLoop(parent.loopId)).toBeUndefined();
    expect(h.rows[0].sessionId).toBe("dashboard-id");
  });

  it("re-subscribes on Gateway reconnect and replays metadata on kernel reconnect without duplicate starts or history", async () => {
    const h = setup();
    await h.inventory.refresh();
    await h.inventory.idle();
    h.request.mockClear();
    h.inventory.onConnected();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("sessions.subscribe", {}));
    await h.inventory.refresh();
    await h.inventory.idle();
    expect(h.requests.filter((r) => r.type === "loop.started")).toHaveLength(3);
    expect(h.request.mock.calls.some(([method]) => method === "chat.history")).toBe(true);
    expect(h.requests.filter((r) => r.payload.output)).toHaveLength(9);
    expect(h.requests.filter((r) => r.type === "loop.progress" && !r.payload.output).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps blocked-on-you true during history and metadata refresh, and clears it only on unblock", async () => {
    const h = setup();
    await h.inventory.refresh();
    const key = h.rows[0].key;
    const target = h.tracker.lookupSession(key)!;
    h.tracker.block({ sessionKey: key }, "operator decision");
    h.tracker.onAgentEnd({ success: true }, { sessionKey: key });
    await h.sender.idle();
    expect(h.requests.at(-1)?.payload.state).toBe("blocked");
    await h.inventory.history(target.loopId);
    await h.inventory.refresh();
    const last = h.requests.filter((r) => r.payload.loopId === target.loopId).at(-1)!;
    expect(last.payload).toMatchObject({ blockedOnYou: true, state: "blocked" });
    h.tracker.unblock({ sessionKey: key });
    await h.sender.idle();
    expect(h.requests.at(-1)?.payload).toMatchObject({ blockedOnYou: false, state: "running" });
  });

  it("deduplicates archived snapshots, allows explicit unarchive and handles reset IDs", async () => {
    const h = setup();
    await h.inventory.refresh();
    const old = h.tracker.lookupSession(h.rows[0].key)!;
    h.rows[0].archived = true;
    await h.inventory.refresh();
    await h.inventory.refresh();
    expect(h.requests.filter((r) => r.type === "loop.finished" && r.payload.loopId === old.loopId)).toHaveLength(1);
    h.rows[0].archived = false;
    await h.inventory.refresh();
    expect(h.tracker.lookupSession(h.rows[0].key)?.loopId).toBe(old.loopId);
    h.rows[0].sessionId = "reset-id";
    await h.inventory.refresh();
    expect(h.tracker.lookupSession(h.rows[0].key)?.loopId).not.toBe(old.loopId);
    expect(h.tracker.resolveLoop(old.loopId)).toBeUndefined();
  });

  it("isolates read failures, retries history after a later event, and ignores unrelated events", async () => {
    const h = setup();
    h.gateway.history = vi.fn().mockRejectedValueOnce(new Error("private Gateway text")).mockResolvedValue([]);
    await h.inventory.refresh();
    await h.inventory.idle();
    expect(h.warn).toHaveBeenCalledWith("[imajin-sessions] inventory/history unavailable");
    await h.inventory.refresh();
    await h.inventory.idle();
    expect(h.gateway.history).toHaveBeenCalledTimes(6);
    h.request.mockClear();
    h.inventory.onEvent({ event: "unrelated" });
    expect(h.request).not.toHaveBeenCalled();
    h.gateway.list = vi.fn().mockRejectedValue(new Error("private Gateway text"));
    h.inventory.onEvent({ event: "sessions.changed" });
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("private Gateway text");
  });

  it("stops publishing when disposed during a pending Gateway read and does not restart", async () => {
    const h = setup();
    let resolve!: (rows: GatewaySession[]) => void;
    h.gateway.list = vi.fn(() => new Promise<GatewaySession[]>((done) => { resolve = done; }));
    const pending = h.inventory.refresh();
    await vi.waitFor(() => expect(h.gateway.list).toHaveBeenCalledOnce());
    h.inventory.dispose();
    resolve(h.rows);
    await pending;
    await h.inventory.refresh();
    expect(h.requests).toHaveLength(0);
    await h.inventory.history("unknown");
    h.inventory.onConnected();
    expect(h.request).not.toHaveBeenCalled();
  });
});
