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

function setup() {
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
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.list") return { sessions: structuredClone(rows) };
    if (method === "chat.history") return { messages: [
      { role: "user", content: "token=synthetic-private-value hello" },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { password: "synthetic-private-value" } }] },
      { role: "toolResult", toolCallId: "call", content: "done" },
    ] };
    return {};
  });
  const gateway = createSessionGateway(request);
  const warn = vi.fn();
  const inventory = createSessionInventory({ gateway, tracker, sender, warn });
  return { rows, requests, request, gateway, tracker, sender, inventory, warn };
}

describe("top-level session inventory", () => {
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
    h.request.mockClear();
    h.inventory.onConnected();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledWith("sessions.subscribe", {}));
    await h.inventory.refresh();
    expect(h.requests.filter((r) => r.type === "loop.started")).toHaveLength(3);
    expect(h.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(0);
    expect(h.requests.filter((r) => r.type === "loop.progress" && !r.payload.output).length).toBeGreaterThanOrEqual(3);
  });

  it("keeps blocked-on-you true during history and metadata refresh, and clears it only on unblock", async () => {
    const h = setup();
    await h.inventory.refresh();
    const key = h.rows[0].key;
    const target = h.tracker.lookupSession(key)!;
    h.tracker.block({ sessionKey: key }, "operator decision");
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
    expect(h.warn).toHaveBeenCalledWith("[imajin-sessions] inventory/history unavailable");
    await h.inventory.refresh();
    expect(h.gateway.history).toHaveBeenCalledTimes(4);
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
    h.inventory.dispose();
    resolve(h.rows);
    await pending;
    await h.inventory.refresh();
    expect(h.requests).toHaveLength(0);
    await expect(h.inventory.history("unknown")).rejects.toThrow("not active");
  });
});
