import { readFile } from "node:fs/promises";
import type { LoopSenderOptions } from "../loop-publisher.js";
import { saveJson } from "./cursor.js";
import { deriveStepId, parseHorizon, record, text, type HorizonItem } from "./model.js";

const STATES = ["queued", "claimed", "running", "blocked", "finished", "exited"];
const ZONES = ["tail", "middle", "near", "head", "past", "done"];
let warned = false;

interface DerivedStep {
  stepId: string;
  publisher: string;
  state: string;
  zone: string;
  claim?: { holderDid: string; expiresAt: string };
}
function date(value: unknown): string {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new Error("invalid kernel date");
  return result;
}
function step(value: unknown): DerivedStep {
  const entry = record(value);
  const stepId = text(entry.stepId);
  const publisher = text(entry.publisher);
  if (!/^did:[^\s:]+:\S+$/.test(publisher)) throw new Error("invalid kernel publisher");
  const state = text(entry.state);
  const zone = text(entry.zone);
  if (!STATES.includes(state) || !ZONES.includes(zone)) throw new Error("invalid kernel projection");
  let claim: DerivedStep["claim"];
  if (entry.claim !== undefined) {
    const lease = record(entry.claim);
    const holderDid = text(lease.holderDid);
    if (!/^did:[^\s:]+:\S+$/.test(holderDid) || lease.leaseId !== `step:${stepId}`) {
      throw new Error("invalid kernel lease");
    }
    const acquiredAt = date(lease.acquiredAt);
    const expiresAt = date(lease.expiresAt);
    if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) throw new Error("invalid kernel lease window");
    claim = { holderDid, expiresAt };
  }
  return { stepId, publisher, state, zone, claim };
}
/** Bound the whole loop/history response; oversized or partial reads are not snapshots. */
async function body(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("missing kernel body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error("kernel snapshot too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function project(item: HorizonItem, remote: DerivedStep, now: number): HorizonItem {
  const next = { ...item, kernelState: remote.state, kernelZone: remote.zone };
  const completed = remote.state === "exited" || ["past", "done"].includes(remote.zone);
  const live = !completed && remote.claim && Date.parse(remote.claim.expiresAt) > now;
  if (live && remote.claim) {
    next.claimedBy = remote.claim.holderDid;
    next.claimExpiresAt = remote.claim.expiresAt;
  } else {
    delete next.claimedBy;
    delete next.claimExpiresAt;
    if (item.claimedBy && !["past", "done"].includes(item.zone)) next.zone = "near";
  }
  if (completed) next.zone = "done";
  return next;
}
/** GET only: signed upward observations and the kernel's projections are separate rails. */
export async function readBackHorizon(options: LoopSenderOptions, loopId: string, filePath: string): Promise<void> {
  try {
    options.signal?.throwIfAborted();
    const cookie = await options.client?.authenticatedCookie();
    const principal = options.principal ?? options.did;
    const response = await (options.fetchImpl ?? fetch)(
      `${options.nodeUrl.replaceAll(/\/$/g, "")}/api/loops/${encodeURIComponent(loopId)}?includeExited=true`,
      {
        method: "GET", redirect: "error",
        headers: {
          "Cache-Control": "no-cache",
          ...(cookie ? { Cookie: cookie } : {}),
          ...(principal !== options.did ? { "X-Acting-For": principal } : {}),
        },
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...options.signal ? [options.signal] : []]),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("kernel horizon unavailable");
    }
    const snapshot = record(await body(response));
    const loop = record(snapshot.loop);
    if (loop.loopId !== loopId || loop.principal !== principal) throw new Error("kernel scope mismatch");
    const horizon = record(snapshot.horizon);
    if (!Array.isArray(horizon.steps)) throw new Error("invalid kernel horizon");
    const entries = horizon.steps.map(step);
    if (new Set(entries.map(entry => entry.stepId)).size !== entries.length) throw new Error("duplicate kernel step");
    const own = new Map(entries.filter(entry => entry.publisher === options.did).map(entry => [entry.stepId, entry]));
    // Re-read after the network await, preserving edits, ordering and unknown bridge fields.
    const raw = await readFile(filePath, "utf8");
    const file = parseHorizon(raw);
    const items = file.items.map(item => {
      const remote = own.get(deriveStepId(loopId, options.did, item.id));
      return remote ? project(item, remote, (options.now ?? Date.now)()) : item;
    });
    if (JSON.stringify(items) === JSON.stringify(file.items)) return;
    // A concurrent bridge replacement is retried next tick, never overwritten.
    if (await readFile(filePath, "utf8") !== raw) return;
    options.signal?.throwIfAborted();
    await saveJson(filePath, { ...record(JSON.parse(raw)), items });
  } catch {
    if (warned) return;
    warned = true;
    (options.logger?.warn ?? console.warn)("[imajin-horizon] kernel read unavailable; bridge unchanged; upward sync remains enabled");
  }
}
