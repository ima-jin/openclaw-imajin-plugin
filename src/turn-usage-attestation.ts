/**
 * agent_end → agent.turn.usage attestation (#1843, #1865)
 *
 * Registers an OpenClaw `agent_end` lifecycle hook that emits a self-signed,
 * UNILATERAL `agent.turn.usage` attestation to the Imajin kernel after every
 * agent turn. `issuer_did` and `subject_did` are both the agent's own DID —
 * the same identity established via the plugin's existing keypair/challenge-
 * response auth path (`ImajinClient.authenticate()`), just asserted here
 * about itself rather than countersigned by anyone else.
 *
 * Mirrors the pattern of `packages/auth/src/emit-attestation.ts`
 * (ima-jin/imajin-ai): the kernel's internal route signs the stored row
 * server-side from its own platform key, so this module only has to build
 * and POST the claim body — it never touches private key material itself.
 *
 * Fire-and-forget: this hook must NEVER block, throw, or fail the turn.
 * Every failure mode (missing config, network error, non-2xx response) is
 * logged and dropped, never retried, never re-thrown.
 *
 * No filtering: $0-cost turns (local models) are attested too — "if
 * something costs $0 we want to know why" is an explicit product decision,
 * not a bug to guard against. Every numeric usage/cost field defaults to 0
 * (never omitted) so a $0 turn is visibly present with zeroed figures
 * rather than silently absent.
 *
 * Retention: the kernel's daily cleanup cron purges any attestation whose
 * `expires_at` has passed (see
 * apps/kernel/app/api/cron/attestation-cleanup in ima-jin/imajin-ai). This
 * module only sets `expires_at` at creation time to opt in to that sweep —
 * it does not implement retention/deletion itself.
 *
 * Transcript pointer + content hash (#1865): the turn's content already
 * lives in the OpenClaw transcript JSONL
 * (`~/.openclaw/agents/<agent>/sessions/<sessionId>.jsonl`, one message per
 * line). Rather than embedding the content in the claim, the payload carries
 * a `transcript` pointer — `sessionId` / `path` / `messageIds` / `lineRange`
 * — plus `contentSha256`, a hash of the turn's message batch. The pointer
 * lets an operator jump to the exact lines; the hash lets a later disclosure
 * be verified against the signed claim without the content ever leaving the
 * agent's own machine (match-without-disclosure applied to transcripts).
 * Content upload is explicitly out of scope here. All pointer fields are
 * read defensively off `agent_end` run metadata (same as `sessionKey` /
 * `runId` above) — a host that omits one simply yields `undefined` for that
 * field; only `contentSha256` is always computable, since it only needs the
 * message batch OpenClaw already hands the hook.
 */

import { createHash } from "node:crypto";

const AGENT_TURN_USAGE_TYPE = "agent.turn.usage";
const AGENT_RUN_CONTEXT_TYPE = "agent_run";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90-day rolling retention window
const DEFAULT_INTERNAL_API_KEY_ENV = "ATTESTATION_INTERNAL_API_KEY";
const INTERNAL_ATTESTATION_PATH = "/auth/api/attestations/internal";

export interface AgentTokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

export interface AgentTurnCost {
  input?: number;
  output?: number;
  total?: number;
}

/** Shape of a single OpenClaw agent message, as far as this hook cares. */
export interface AgentMessage {
  /** Transcript-JSONL message id (#1865) — collected into `transcript.messageIds`. */
  id?: string;
  role?: string;
  usage?: AgentTokenUsage;
  cost?: AgentTurnCost;
  contextUsage?: unknown;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

/**
 * The `agent_end` event OpenClaw's extension runner emits: `{ type,
 * messages }` per #1843, plus whatever session/run metadata the host
 * attaches alongside it. All metadata fields are read defensively — a host
 * that omits one simply yields `undefined` for that field in the payload.
 *
 * `sessionId` (a UUID, distinct from the composite `sessionKey`),
 * `agentName`, `transcriptPath`, and `lineRange` are the run-metadata fields
 * #1865 reads to build `transcript` (log-line pointer into the OpenClaw
 * session JSONL). `transcriptPath`, when the host provides it directly, is
 * preferred verbatim over deriving one from `agentName` + `sessionId`.
 */
export interface AgentEndEvent {
  type?: string;
  messages?: AgentMessage[];
  sessionKey?: string;
  sessionId?: string;
  agentName?: string;
  transcriptPath?: string;
  lineRange?: [number, number];
  runId?: string;
  model?: string;
  provider?: string;
  channel?: string;
  durationMs?: number;
  [key: string]: unknown;
}

/**
 * Transcript pointer + content hash (#1865). `sessionId` / `path` /
 * `messageIds` / `lineRange` are the "where this turn is captured" pointer
 * (each individually may be `undefined` when the host doesn't supply it);
 * `contentSha256` is the tamper-evident commitment to the turn's message
 * batch and is always present.
 */
export interface TranscriptPointer {
  sessionId?: string;
  path?: string;
  messageIds: string[];
  lineRange?: [number, number];
  contentSha256: string;
}

export interface TurnUsagePayload {
  ts: number;
  sessionKey?: string;
  runId?: string;
  model?: string;
  provider?: string;
  channel?: string;
  durationMs?: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
  cost: { input: number; output: number; total: number };
  contextUsage: unknown;
  transcript: TranscriptPointer;
}

export interface AttestationClaim {
  issuer_did: string;
  subject_did: string;
  type: typeof AGENT_TURN_USAGE_TYPE;
  context_type: typeof AGENT_RUN_CONTEXT_TYPE;
  context_id: string;
  payload: TurnUsagePayload;
  expires_at: string;
}

/** `plugins.entries.imajin.config.attestation` (openclaw.json). */
export interface TurnUsageAttestationConfig {
  /** Base URL for the attestation service. Defaults to the plugin's `nodeUrl`. */
  serviceUrl?: string;
  /** Internal API key. Falls back to `process.env.ATTESTATION_INTERNAL_API_KEY`. */
  internalApiKey?: string;
  /** Explicit opt-out. Defaults to true when `serviceUrl` + the key both resolve. */
  enabled?: boolean;
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The final assistant message on the turn carries the authoritative
 * per-turn usage/cost/contextUsage figures. Falls back to the last message
 * overall when no assistant-authored message is present, so a malformed or
 * unusual event still yields *something* rather than silently dropping the
 * attestation.
 */
export function findFinalAssistantMessage(
  messages: AgentMessage[] | undefined,
): AgentMessage | undefined {
  if (!messages || messages.length === 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messages[i];
  }
  return messages[messages.length - 1];
}

/**
 * Normalizes usage/cost figures off the final assistant message. Missing
 * numeric fields become 0 rather than being omitted — a $0 turn must be
 * attested with zeroed figures, never filtered out.
 */
export function extractTurnUsage(
  message: AgentMessage | undefined,
): Pick<TurnUsagePayload, "usage" | "cost" | "contextUsage"> {
  const usage = message?.usage ?? {};
  const cost = message?.cost ?? {};
  return {
    usage: {
      input: toNumber(usage.input),
      output: toNumber(usage.output),
      cacheRead: toNumber(usage.cacheRead),
      cacheWrite: toNumber(usage.cacheWrite),
      totalTokens: toNumber(usage.totalTokens),
    },
    cost: {
      input: toNumber(cost.input),
      output: toNumber(cost.output),
      total: toNumber(cost.total),
    },
    contextUsage: message?.contextUsage ?? null,
  };
}

/**
 * Collects transcript-JSONL message ids off the turn's message batch
 * (#1865). Messages without a string `id` are skipped rather than yielding
 * a hole in the array — a partial pointer is more useful than one padded
 * with `undefined` entries.
 */
export function extractMessageIds(messages: AgentMessage[] | undefined): string[] {
  if (!messages) return [];
  return messages
    .map((message) => message?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Hashes the turn's full message batch (not just the final assistant
 * message) as the tamper-evident commitment carried in the claim. Always
 * computable — an empty/undefined batch still hashes deterministically —
 * so `transcript.contentSha256` is never omitted, mirroring the "never
 * omitted, always present" numeric-field convention used for usage/cost
 * above.
 */
export function computeTurnContentHash(messages: AgentMessage[] | undefined): string {
  const serialized = JSON.stringify(messages ?? []);
  return createHash("sha256").update(serialized).digest("hex");
}

/**
 * Builds the `agents/<agent>/sessions/<sessionId>.jsonl` transcript path
 * from run metadata. Returns `undefined` rather than guessing when either
 * segment is missing — a wrong pointer is worse than an absent one.
 */
export function buildTranscriptPath(
  agentName: string | undefined,
  sessionId: string | undefined,
): string | undefined {
  if (!agentName || !sessionId) return undefined;
  return `agents/${agentName}/sessions/${sessionId}.jsonl`;
}

/**
 * Assembles the `transcript` pointer + hash carried on `TurnUsagePayload`
 * (#1865). `path` prefers the host-supplied `event.transcriptPath`
 * verbatim, falling back to deriving one from `agentName` + `sessionId`.
 */
export function buildTranscriptPointer(event: AgentEndEvent): TranscriptPointer {
  return {
    sessionId: event.sessionId,
    path: event.transcriptPath ?? buildTranscriptPath(event.agentName, event.sessionId),
    messageIds: extractMessageIds(event.messages),
    lineRange: event.lineRange,
    contentSha256: computeTurnContentHash(event.messages),
  };
}

/** Builds the `agent.turn.usage` attestation payload from the `agent_end` event. */
export function buildTurnUsagePayload(
  event: AgentEndEvent,
  finalMessage: AgentMessage | undefined,
): TurnUsagePayload {
  const { usage, cost, contextUsage } = extractTurnUsage(finalMessage);
  return {
    ts: Date.now(),
    sessionKey: event.sessionKey,
    runId: event.runId,
    model: event.model ?? finalMessage?.model,
    provider: event.provider ?? finalMessage?.provider,
    channel: event.channel,
    durationMs: event.durationMs,
    usage,
    cost,
    contextUsage,
    transcript: buildTranscriptPointer(event),
  };
}

/** Builds the unilateral, self-signed `agent.turn.usage` claim for the given agent DID. */
export function buildTurnUsageClaim(did: string, payload: TurnUsagePayload): AttestationClaim {
  const contextId = payload.sessionKey || payload.runId || "unknown";
  return {
    issuer_did: did,
    subject_did: did,
    type: AGENT_TURN_USAGE_TYPE,
    context_type: AGENT_RUN_CONTEXT_TYPE,
    context_id: contextId,
    payload,
    expires_at: new Date(Date.now() + RETENTION_MS).toISOString(),
  };
}

function resolveInternalApiKey(config: TurnUsageAttestationConfig): string | undefined {
  return config.internalApiKey || process.env[DEFAULT_INTERNAL_API_KEY_ENV];
}

/**
 * POST the claim to the kernel's internal attestations endpoint.
 *
 * Fire-and-forget: NEVER throws or rejects. All failures — network errors,
 * non-2xx responses — are logged and dropped. Mirrors
 * `packages/auth/src/emit-attestation.ts` (ima-jin/imajin-ai).
 */
export async function postTurnUsageAttestation(
  serviceUrl: string,
  internalApiKey: string,
  claim: AttestationClaim,
): Promise<void> {
  try {
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}${INTERNAL_ATTESTATION_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${internalApiKey}`,
      },
      body: JSON.stringify(claim),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[imajin-plugin] agent.turn.usage attestation POST failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
  } catch (err: unknown) {
    console.error(
      "[imajin-plugin] agent.turn.usage attestation POST error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Resolves the effective attestation settings, returning `undefined` when
 * the hook should not be registered at all (explicitly disabled, or missing
 * the DID/serviceUrl/internalApiKey it needs to do anything useful).
 */
function resolveSettings(
  did: string | undefined,
  config: TurnUsageAttestationConfig,
): { did: string; serviceUrl: string; internalApiKey: string } | undefined {
  if (config.enabled === false) return undefined;

  if (!did) {
    console.warn("[imajin-plugin] agent.turn.usage attestation disabled — no agent DID configured");
    return undefined;
  }

  const serviceUrl = config.serviceUrl;
  const internalApiKey = resolveInternalApiKey(config);
  if (!serviceUrl || !internalApiKey) {
    console.warn(
      "[imajin-plugin] agent.turn.usage attestation disabled — missing attestation serviceUrl/internalApiKey",
    );
    return undefined;
  }

  return { did, serviceUrl, internalApiKey };
}

/**
 * Builds the `agent_end` hook handler (#1843), or `undefined` when the
 * feature is disabled or unconfigured (in which case the caller should skip
 * `registerHook` entirely).
 *
 * Never blocks or fails the turn: usage extraction happens synchronously
 * and defensively (missing fields default to 0/undefined rather than
 * throwing), the whole body is wrapped in try/catch, and the network POST
 * is fired without being awaited by the handler.
 */
export function createTurnUsageAttestationHandler(
  did: string | undefined,
  config: TurnUsageAttestationConfig,
): ((event: AgentEndEvent) => void) | undefined {
  const settings = resolveSettings(did, config);
  if (!settings) return undefined;
  const { did: issuerDid, serviceUrl, internalApiKey } = settings;

  return function handleAgentEnd(event: AgentEndEvent): void {
    try {
      const finalMessage = findFinalAssistantMessage(event?.messages);
      const payload = buildTurnUsagePayload(event ?? {}, finalMessage);
      const claim = buildTurnUsageClaim(issuerDid, payload);
      // Fire-and-forget — deliberately not awaited or returned so the turn
      // never blocks on (or fails from) the attestation POST.
      void postTurnUsageAttestation(serviceUrl, internalApiKey, claim);
    } catch (err: unknown) {
      console.error(
        "[imajin-plugin] agent.turn.usage attestation handler error:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}
