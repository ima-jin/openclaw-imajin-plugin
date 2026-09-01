/**
 * Imajin tools for OpenClaw agents.
 *
 * Five tools mapping to Imajin's five primitives:
 * 1. imajin_identity  — look up DIDs, check trust graph, resolve handles
 * 2. imajin_attest    — create and verify attestations
 * 3. imajin_transact  — check balances, view transactions, initiate payments
 * 4. imajin_fair      — inspect .fair attribution manifests
 * 5. imajin_discover  — search the network (people, events, market, stubs)
 */

import { readFile } from "node:fs/promises";
import type { ImajinChat } from "./chat.js";
import { validateDid } from "./client.js";
import type { ImajinClient } from "./client.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = {
  content: ToolContent[];
  details?: Record<string, unknown>;
};

function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(msg: string): ToolResult {
  return textResult(`Error: ${msg}`, { error: true });
}

function jsonResult(data: unknown): ToolResult {
  return textResult(JSON.stringify(data, null, 2));
}

function truncateResults(data: unknown[], max = 20): unknown[] {
  if (data.length <= max) return data;
  return [...data.slice(0, max), { _truncated: true, total: data.length, showing: max }];
}

// --- Tool definitions ---

export function createIdentityTool(client: ImajinClient) {
  return {
    name: "imajin_identity",
    label: "Imajin Identity",
    description:
      "Look up identities on the Imajin network. Actions: lookup (by handle/name/DID), " +
      "connections (get trust graph connections for a DID).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["lookup", "connections"],
          description: "Action to perform",
        },
        query: {
          type: "string" as const,
          description: "Handle, name, or DID to look up",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). The agent must have role:agent membership on the target DID.',
        },
      },
      required: ["action", "query"],
    },
    async execute(
      _id: string,
      params: { action: string; query: string; onBehalfOf?: string },
    ): Promise<ToolResult> {
      if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
        return errorResult(`Invalid DID format for onBehalfOf: ${params.onBehalfOf}`);
      }
      try {
        switch (params.action) {
          case "lookup": {
            const identity = await client.lookupIdentity(params.query);
            if (!identity) return textResult(`No identity found for: ${params.query}`);
            return jsonResult(identity);
          }
          case "connections": {
            const connections = await client.getConnections(params.query);
            if (!connections.length) return textResult(`No connections found for: ${params.query}`);
            return jsonResult(connections);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createAttestTool(client: ImajinClient) {
  return {
    name: "imajin_attest",
    label: "Imajin Attestation",
    description:
      "Create or verify attestations on the Imajin network. Actions: list (get attestations for a DID), " +
      "create (create a new attestation — requires agent keypair).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["list", "create"],
          description: "Action to perform",
        },
        did: {
          type: "string" as const,
          description: "DID to list attestations for, or subject DID for creation",
        },
        type: {
          type: "string" as const,
          description: "Attestation type (for create)",
        },
        claim: {
          type: "object" as const,
          description: "Claim data (for create)",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). The agent must have role:agent membership on the target DID.',
        },
      },
      required: ["action", "did"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        did: string;
        type?: string;
        claim?: Record<string, unknown>;
        onBehalfOf?: string;
      },
    ): Promise<ToolResult> {
      if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
        return errorResult(`Invalid DID format for onBehalfOf: ${params.onBehalfOf}`);
      }
      try {
        switch (params.action) {
          case "list": {
            const attestations = await client.getAttestations(params.did);
            if (!attestations.length) return textResult(`No attestations found for: ${params.did}`);
            return jsonResult(attestations);
          }
          case "create": {
            if (!params.type || !params.claim) {
              return errorResult("create requires 'type' and 'claim' parameters");
            }
            const attestation = await client.createAttestation(
              {
                type: params.type,
                issuer: "", // will be set by the node from agent DID
                subject: params.did,
                claim: params.claim,
              },
              params.onBehalfOf,
            );
            return jsonResult(attestation);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createTransactTool(client: ImajinClient) {
  return {
    name: "imajin_transact",
    label: "Imajin Settlement",
    description:
      "Check MJNx/MJN balances and view transaction history on the Imajin network. " +
      "Actions: balance (check balance for a DID), transactions (list recent transactions).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["balance", "transactions"],
          description: "Action to perform",
        },
        did: {
          type: "string" as const,
          description: "DID to check (defaults to agent's own DID if omitted)",
        },
        limit: {
          type: "number" as const,
          description: "Number of transactions to return (default 20)",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). The agent must have role:agent membership on the target DID.',
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: { action: string; did?: string; limit?: number; onBehalfOf?: string },
    ): Promise<ToolResult> {
      if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
        return errorResult(`Invalid DID format for onBehalfOf: ${params.onBehalfOf}`);
      }
      try {
        switch (params.action) {
          case "balance": {
            const balance = await client.getBalance(params.did);
            return jsonResult(balance);
          }
          case "transactions": {
            const txns = await client.getTransactions(params.did, params.limit);
            if (!txns.length) return textResult("No transactions found");
            return jsonResult(txns);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createFairTool(client: ImajinClient) {
  return {
    name: "imajin_fair",
    label: "Imajin .fair Attribution",
    description:
      "Inspect .fair attribution manifests — who made what and who gets paid. " +
      "Shows the complete breakdown of shares and fees for any transaction.",
    parameters: {
      type: "object" as const,
      properties: {
        transactionId: {
          type: "string" as const,
          description: "Transaction ID to inspect the .fair manifest for",
        },
      },
      required: ["transactionId"],
    },
    async execute(_id: string, params: { transactionId: string }): Promise<ToolResult> {
      try {
        const manifest = await client.getFairManifest(params.transactionId);
        if (!manifest)
          return textResult(`No .fair manifest found for transaction: ${params.transactionId}`);
        return jsonResult(manifest);
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createDiscoverTool(client: ImajinClient) {
  return {
    name: "imajin_discover",
    label: "Imajin Discovery",
    description:
      "Search the Imajin network for people, businesses, events, market items, communities, and stubs. " +
      "Optional type filter: person, business, community, event, market, stub.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: "Search query",
        },
        type: {
          type: "string" as const,
          enum: ["person", "business", "community", "event", "market", "stub"],
          description: "Filter by type (optional)",
        },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; type?: string }): Promise<ToolResult> {
      try {
        const results = await client.search(params.query, params.type);
        if (!results.length) return textResult(`No results found for: ${params.query}`);
        return jsonResult(truncateResults(results));
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createWarpTool(client: ImajinClient) {
  return {
    name: "imajin_warp",
    label: "Imajin Warp",
    description:
      "Dispatch and control Warp cloud agents through the Imajin kernel (#1428, #1639). " +
      "Attribution follows the acting principal's sealed Warp key (run stamped {username}-jin), " +
      "never the human. Actions: " +
      "dispatch (fire a cloud agent with a prompt; optional skillSpec 'owner/repo:skill' and " +
      "mcpServers map to compose skills + scoped MCP servers; optional conversationId to continue " +
      "an existing conversation and parentRunId for an orchestration hierarchy (#1939)), " +
      "get_run (read a run's lifecycle state + session link by runId), " +
      "cancel_run (kill a queued or in-progress run by runId — the revocation half of dispatch; " +
      "the kernel's 400/409/422 refusals for an already-terminal, still-PENDING, or " +
      "non-cancellable run surface as errors), " +
      "send_followup (deliver a mid-run message to a run by runId + message, optional mode " +
      "'normal'|'plan'|'orchestrate'; acceptance is not application — check get_run for the effect. " +
      "A terminal run is refused with 409 unless resume: true is also given (#1939), which " +
      "continues it via Warp's cloud-to-cloud handoff), " +
      "list_runs (list the principal's own runs, newest-updated first, with optional name/states/ " +
      "environmentId/createdAfter/limit/cursor/ancestorRunId filters — ancestorRunId lists every " +
      "run spawned, directly or transitively, from that run's parentRunId lineage (#1939)), " +
      "get_transcript (read a run's raw transcript by runId — the self-diagnosis path for a failed run; " +
      "optional maxChars caps the returned text), " +
      "seal_key (seal a Warp Agent API key for the principal as a delegation-grant vault field — " +
      "owner-authored; the key is never logged or echoed). " +
      "Authority is enforced kernel-side: a missing warp:dispatch grant fails 403, an unsealed key fails 409. " +
      "Every action reaches only runs the acting principal's own sealed key created — there is no " +
      "cross-DID surface to grant separately.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "dispatch",
            "get_run",
            "cancel_run",
            "send_followup",
            "list_runs",
            "get_transcript",
            "seal_key",
          ],
          description: "Action to perform",
        },
        prompt: {
          type: "string" as const,
          description: "The task for the cloud agent to carry out (for dispatch)",
        },
        title: {
          type: "string" as const,
          description: "Optional human-readable run title (for dispatch)",
        },
        name: {
          type: "string" as const,
          description: "Optional override for the {username}-jin run tag (for dispatch)",
        },
        modelId: {
          type: "string" as const,
          description: "Optional model override, defaults to the team default (for dispatch)",
        },
        basePrompt: {
          type: "string" as const,
          description: "Optional base prompt shaping agent behaviour (for dispatch)",
        },
        environmentId: {
          type: "string" as const,
          description: "Optional Warp cloud environment UID to run in (for dispatch)",
        },
        conversationId: {
          type: "string" as const,
          description:
            "Optional conversation id to continue (#1939) — Warp resumes from where a prior run " +
            "under this conversation left off (for dispatch)",
        },
        parentRunId: {
          type: "string" as const,
          description:
            "Optional parent run id for an orchestration hierarchy (#1939). The parent run must " +
            "exist and be visible to the acting principal's own sealed key (for dispatch)",
        },
        skillSpec: {
          type: "string" as const,
          description: "Optional versioned SKILL.md as payload, 'owner/repo:skill' (for dispatch)",
        },
        mcpServers: {
          type: "object" as const,
          description:
            "Optional map of MCP servers keyed by name, each { url, headers? } (for dispatch)",
        },
        attachImajinMcp: {
          type: "boolean" as const,
          description: "Attach the OAuth-protected mcp.imajin.ai server, defaults off (for dispatch)",
        },
        computerUseEnabled: {
          type: "boolean" as const,
          description: "Enable computer-use for the agent (for dispatch)",
        },
        runId: {
          type: "string" as const,
          description:
            "The run id returned by dispatch (for get_run, cancel_run, send_followup, get_transcript)",
        },
        message: {
          type: "string" as const,
          description: "The follow-up message to deliver to the run (for send_followup)",
        },
        mode: {
          type: "string" as const,
          enum: ["normal", "plan", "orchestrate"],
          description: "Optional follow-up routing mode, defaults to 'normal' (for send_followup)",
        },
        resume: {
          type: "boolean" as const,
          description:
            "Continue a run that has already ended, via cloud-to-cloud handoff (#1939). Defaults " +
            "to false — a terminal run is refused unless this is explicitly true (for send_followup)",
        },
        states: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Filter by run state(s), e.g. QUEUED, INPROGRESS, SUCCEEDED, FAILED, CANCELLED (for list_runs)",
        },
        createdAfter: {
          type: "string" as const,
          description: "RFC-3339 lower bound on created_at (for list_runs)",
        },
        limit: {
          type: "number" as const,
          description: "Max runs to return, 1-500, clamped kernel-side (for list_runs)",
        },
        cursor: {
          type: "string" as const,
          description: "Pagination cursor from a previous list_runs page's nextCursor (for list_runs)",
        },
        ancestorRunId: {
          type: "string" as const,
          description:
            "Optional run id (#1939) — lists every run spawned, directly or transitively, from " +
            "this ancestor's parentRunId lineage (for list_runs)",
        },
        maxChars: {
          type: "number" as const,
          description: "Optional cap on transcript characters returned (for get_transcript)",
        },
        agentKey: {
          type: "string" as const,
          description:
            "Warp Agent API key to seal (for seal_key). Secret — sealed as a delegation-grant " +
            "vault field; never logged or echoed back.",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). ' +
            "The grant + sealed key are resolved against this principal. Defaults to the client's configured actAs.",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        prompt?: string;
        title?: string;
        name?: string;
        modelId?: string;
        basePrompt?: string;
        environmentId?: string;
        conversationId?: string;
        parentRunId?: string;
        skillSpec?: string;
        mcpServers?: Record<string, { url: string; headers?: Record<string, string> }>;
        attachImajinMcp?: boolean;
        computerUseEnabled?: boolean;
        runId?: string;
        message?: string;
        mode?: string;
        resume?: boolean;
        states?: string[];
        createdAfter?: string;
        limit?: number;
        cursor?: string;
        ancestorRunId?: string;
        maxChars?: number;
        agentKey?: string;
        onBehalfOf?: string;
      },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "dispatch": {
            if (!params.prompt) return errorResult("dispatch requires 'prompt'");
            const run = await client.dispatchWarp(
              {
                prompt: params.prompt,
                ...(params.title === undefined ? {} : { title: params.title }),
                ...(params.name === undefined ? {} : { name: params.name }),
                ...(params.modelId === undefined ? {} : { modelId: params.modelId }),
                ...(params.basePrompt === undefined ? {} : { basePrompt: params.basePrompt }),
                ...(params.environmentId === undefined
                  ? {}
                  : { environmentId: params.environmentId }),
                ...(params.conversationId === undefined
                  ? {}
                  : { conversationId: params.conversationId }),
                ...(params.parentRunId === undefined ? {} : { parentRunId: params.parentRunId }),
                ...(params.skillSpec === undefined ? {} : { skillSpec: params.skillSpec }),
                ...(params.mcpServers === undefined ? {} : { mcpServers: params.mcpServers }),
                ...(params.attachImajinMcp === undefined
                  ? {}
                  : { attachImajinMcp: params.attachImajinMcp }),
                ...(params.computerUseEnabled === undefined
                  ? {}
                  : { computerUseEnabled: params.computerUseEnabled }),
              },
              params.onBehalfOf,
            );
            return jsonResult(run);
          }
          case "get_run": {
            if (!params.runId) return errorResult("get_run requires 'runId'");
            const run = await client.getWarpRun(params.runId, params.onBehalfOf);
            return jsonResult(run);
          }
          case "cancel_run": {
            if (!params.runId) return errorResult("cancel_run requires 'runId'");
            const result = await client.cancelWarpRun(params.runId, params.onBehalfOf);
            return jsonResult(result);
          }
          case "send_followup": {
            if (!params.runId) return errorResult("send_followup requires 'runId'");
            if (!params.message) return errorResult("send_followup requires 'message'");
            const result = await client.sendWarpFollowup(
              params.runId,
              {
                message: params.message,
                ...(params.mode === undefined
                  ? {}
                  : { mode: params.mode as "normal" | "plan" | "orchestrate" }),
                ...(params.resume === undefined ? {} : { resume: params.resume }),
              },
              params.onBehalfOf,
            );
            return jsonResult(result);
          }
          case "list_runs": {
            const page = await client.listWarpRuns(
              {
                ...(params.name === undefined ? {} : { name: params.name }),
                ...(params.states === undefined ? {} : { states: params.states }),
                ...(params.environmentId === undefined
                  ? {}
                  : { environmentId: params.environmentId }),
                ...(params.createdAfter === undefined ? {} : { createdAfter: params.createdAfter }),
                ...(params.limit === undefined ? {} : { limit: params.limit }),
                ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
                ...(params.ancestorRunId === undefined
                  ? {}
                  : { ancestorRunId: params.ancestorRunId }),
              },
              params.onBehalfOf,
            );
            if (!page.runs.length) return textResult("No Warp runs found");
            return jsonResult({ ...page, runs: truncateResults(page.runs) });
          }
          case "get_transcript": {
            if (!params.runId) return errorResult("get_transcript requires 'runId'");
            const transcript = await client.getWarpRunTranscript(
              params.runId,
              params.maxChars === undefined ? {} : { maxChars: params.maxChars },
              params.onBehalfOf,
            );
            return jsonResult(transcript);
          }
          case "seal_key": {
            if (!params.agentKey) return errorResult("seal_key requires 'agentKey'");
            await client.sealWarpKey(params.agentKey, params.onBehalfOf);
            // Never echo the key or any response field that might carry it.
            return textResult("Warp Agent key sealed for the acting principal.");
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createInferTool(client: ImajinClient) {
  return {
    name: "imajin_infer",
    label: "Imajin Infer",
    description:
      "Drive the Imajin kernel's intention-inference engine on behalf of a principal (#1620). " +
      "This is the app-as-intention-inference-engine primitive: a gesture (audio/photo/file) is " +
      "captured and run through capture -> context(transcribe/telemetry) -> infer(LLM) -> consent gate, " +
      "where inference resolves the principal's own sealed model credential (e.g. the gemini:infer " +
      "connector key) instead of a global env var. Actions: " +
      "capture (POST a gesture file; runs the pipeline; returns { sessionId, assetId, status, candidateIntents }; " +
      "status 'resolved' = silent intent done, 'pending_confirm' = deliberate intent awaiting the human tap), " +
      "confirm (the human deliberate-consent tap for a pending_confirm session -> advances to resolved, " +
      "returns the attestation; NOTHING is sent/spent/disclosed without it), " +
      "sessions (list the principal's recent inference sessions). " +
      "Authority is enforced kernel-side via the acting DID. DO NOT auto-confirm a deliberate intent " +
      "without an explicit human confirmation — that tap IS the consent event.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["capture", "confirm", "sessions"],
          description: "Action to perform",
        },
        path: {
          type: "string" as const,
          description: "Local file path to the gesture (audio/photo/file) to capture (for capture)",
        },
        vocabulary: {
          type: "string" as const,
          description: "Vocabulary name for the intent inference, default 'imajin' (for capture)",
        },
        filename: {
          type: "string" as const,
          description: "Override filename (defaults to basename of path) (for capture)",
        },
        mimeType: {
          type: "string" as const,
          description: "MIME type (auto-detected from extension if omitted) (for capture)",
        },
        sessionId: {
          type: "string" as const,
          description: "Inference session id returned by capture (for confirm)",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). ' +
            "Inference credentials + grants are resolved against this principal. Defaults to the client's configured actAs.",
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        path?: string;
        vocabulary?: string;
        filename?: string;
        mimeType?: string;
        sessionId?: string;
        onBehalfOf?: string;
      },
    ): Promise<ToolResult> {
      try {
        switch (params.action) {
          case "capture": {
            if (!params.path) return errorResult("capture requires 'path' (a gesture file)");
            const buffer = Buffer.from(await readFile(params.path));
            const basename = params.path.split("/").pop() || "capture";
            const filename = params.filename || basename;
            const mime = params.mimeType || guessMime(filename);
            const result = await client.captureInference(
              buffer,
              filename,
              mime,
              params.vocabulary || "imajin",
              params.onBehalfOf,
            );
            return jsonResult(result);
          }
          case "confirm": {
            if (!params.sessionId) return errorResult("confirm requires 'sessionId'");
            const result = await client.confirmInference(params.sessionId, params.onBehalfOf);
            return jsonResult(result);
          }
          case "sessions": {
            const result = await client.listInferenceSessions(params.onBehalfOf);
            return jsonResult(result);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export function createMediaTool(client: ImajinClient) {
  return {
    name: "imajin_media",
    label: "Imajin Media",
    description:
      "Upload, list, retrieve, and manage media assets on the Imajin network. " +
      "Actions: upload (create a NEW asset from a local file path), " +
      "update (overwrite the text content of an EXISTING asset in place — same asset id, " +
      "new version/CID/.fair; use this to version a doc instead of re-uploading and minting orphans), " +
      "list (list assets with optional filters), " +
      "get (get a single asset by ID), content (read the raw text body of a text/article asset), " +
      "transcribe (audio/video → Whisper transcript, pinned to the asset), " +
      "move-to-folder (move asset to a folder), " +
      "set-access (change access level: public/private/conversation), " +
      "grant-access (allow a specific DID), publish-as-article (publish asset as an article).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "upload",
            "update",
            "list",
            "get",
            "content",
            "transcribe",
            "move-to-folder",
            "set-access",
            "grant-access",
            "publish-as-article",
          ],
          description: "Action to perform",
        },
        path: {
          type: "string" as const,
          description:
            "Local file path to upload (for upload). For update, either pass 'path' " +
            "(reads the file's text) or pass 'content' directly.",
        },
        content: {
          type: "string" as const,
          description:
            "New text content for the asset (for update). If omitted, 'path' is read instead.",
        },
        filename: {
          type: "string" as const,
          description: "Filename for the upload (defaults to basename of path)",
        },
        mimeType: {
          type: "string" as const,
          description: "MIME type (for upload, auto-detected from extension if omitted)",
        },
        context: {
          type: "string" as const,
          enum: [
            "profile",
            "chat",
            "events",
            "market",
            "bugs",
            "voice",
            "document",
            "outreach",
            "article",
            "essay",
          ],
          description: "Upload context — determines access level and folder (for upload)",
        },
        assetId: {
          type: "string" as const,
          description:
            "Asset ID (for update, get, move-to-folder, set-access, grant-access, publish-as-article)",
        },
        folderId: {
          type: "string" as const,
          description: "Folder ID to move asset into (for move-to-folder)",
        },
        access: {
          type: "string" as const,
          enum: ["public", "private", "conversation"],
          description: "Access level to set (for set-access)",
        },
        did: {
          type: "string" as const,
          description: "DID to grant access to (for grant-access)",
        },
        slug: {
          type: "string" as const,
          description: "URL slug for the article (for publish-as-article)",
        },
        title: {
          type: "string" as const,
          description: "Article title (for publish-as-article)",
        },
        subtitle: {
          type: "string" as const,
          description: "Article subtitle (optional, for publish-as-article)",
        },
        description: {
          type: "string" as const,
          description: "Article description (optional, for publish-as-article)",
        },
        status: {
          type: "string" as const,
          enum: ["POSTED", "REVIEW", "DRAFT"],
          description: "Article status (optional, defaults to POSTED, for publish-as-article)",
        },
        search: {
          type: "string" as const,
          description: "Search term for filtering assets (for list action)",
        },
        type: {
          type: "string" as const,
          enum: ["image", "audio", "video", "text"],
          description: "Filter by media type (for list action)",
        },
        limit: {
          type: "number" as const,
          description: "Max results to return (for list, default 20)",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). The agent must have role:agent membership on the target DID.',
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        path?: string;
        content?: string;
        filename?: string;
        mimeType?: string;
        context?: string;
        assetId?: string;
        folderId?: string;
        access?: string;
        did?: string;
        slug?: string;
        title?: string;
        subtitle?: string;
        description?: string;
        status?: string;
        search?: string;
        type?: string;
        limit?: number;
        onBehalfOf?: string;
      },
    ): Promise<ToolResult> {
      if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
        return errorResult(`Invalid DID format for onBehalfOf: ${params.onBehalfOf}`);
      }
      try {
        switch (params.action) {
          case "upload": {
            if (!params.path) return errorResult("'path' is required for upload");
            const buffer = Buffer.from(await readFile(params.path));
            const basename = params.path.split("/").pop() || "upload";
            const filename = params.filename || basename;
            const mime = params.mimeType || guessMime(filename);
            const ctx = params.context ? { app: params.context } : undefined;
            const asset = await client.uploadMedia(buffer, filename, mime, ctx, params.onBehalfOf);
            return jsonResult(asset);
          }
          case "update": {
            if (!params.assetId) return errorResult("'assetId' is required for update");
            let content = params.content;
            if (content === undefined) {
              if (!params.path) {
                return errorResult("update requires either 'content' or 'path'");
              }
              content = new TextDecoder().decode(await readFile(params.path));
            }
            const result = await client.updateMediaContent(
              params.assetId,
              content,
              params.onBehalfOf,
            );
            return jsonResult(result);
          }
          case "list": {
            const result = await client.listMedia({
              search: params.search,
              type: params.type,
              limit: params.limit || 20,
              onBehalfOf: params.onBehalfOf,
            });
            if (!result.assets.length) return textResult("No media assets found");
            return jsonResult({ count: result.count, assets: truncateResults(result.assets) });
          }
          case "get": {
            if (!params.assetId) return errorResult("'assetId' is required for get");
            // getMedia now throws on real auth/permission/transport failures (no more
            // silent null masquerading as "not found"); null means a genuine 404.
            const asset = await client.getMedia(params.assetId, params.onBehalfOf);
            if (!asset) return textResult(`Asset not found (404): ${params.assetId}`);
            return jsonResult(asset);
          }
          case "content": {
            if (!params.assetId) return errorResult("'assetId' is required for content");
            const result = await client.getMediaContent(params.assetId, params.onBehalfOf);
            return jsonResult(result);
          }
          case "transcribe": {
            if (!params.assetId) return errorResult("'assetId' is required for transcribe");
            const result = await client.transcribeMedia(params.assetId, params.onBehalfOf);
            return jsonResult(result);
          }
          case "move-to-folder": {
            if (!params.assetId) return errorResult("'assetId' is required for move-to-folder");
            if (!params.folderId) return errorResult("'folderId' is required for move-to-folder");
            const result = await client.moveMediaToFolder(
              params.assetId,
              params.folderId,
              params.onBehalfOf,
            );
            return jsonResult(result);
          }
          case "set-access": {
            if (!params.assetId) return errorResult("'assetId' is required for set-access");
            if (!params.access) return errorResult("'access' is required for set-access");
            const asset = await client.setMediaAccess(
              params.assetId,
              params.access as "public" | "private" | "conversation",
              params.onBehalfOf,
            );
            return jsonResult(asset);
          }
          case "grant-access": {
            if (!params.assetId) return errorResult("'assetId' is required for grant-access");
            if (!params.did) return errorResult("'did' is required for grant-access");
            const asset = await client.grantMediaAccess(
              params.assetId,
              params.did,
              params.onBehalfOf,
            );
            return jsonResult(asset);
          }
          case "publish-as-article": {
            if (!params.assetId) return errorResult("'assetId' is required for publish-as-article");
            if (!params.slug) return errorResult("'slug' is required for publish-as-article");
            if (!params.title) return errorResult("'title' is required for publish-as-article");
            const asset = await client.publishMediaAsArticle(
              params.assetId,
              {
                slug: params.slug,
                title: params.title,
                subtitle: params.subtitle,
                description: params.description,
                status: (params.status as "POSTED" | "REVIEW" | "DRAFT") || "POSTED",
              },
              params.onBehalfOf,
            );
            return jsonResult(asset);
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

// --- MIME type inference from file extension ---

const EXT_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};

function guessMime(filename: string): string {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  return EXT_MIME[ext] || "application/octet-stream";
}

// --- Chat tool ---

export function createChatTool(chat: ImajinChat) {
  return {
    name: "imajin_chat",
    label: "Imajin Chat",
    description:
      "Send and receive messages on the Imajin network. " +
      "Actions: send_dm (send a direct message to a DID or handle), " +
      "get_dms (get recent DMs with a specific person), " +
      "list_conversations (list all conversations), " +
      "send (send to any conversation DID), " +
      "get_messages (get messages from any conversation).",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["send_dm", "get_dms", "list_conversations", "send", "get_messages"],
          description: "Action to perform",
        },
        to: {
          type: "string" as const,
          description: "Recipient DID for send_dm, or conversation DID for send/get_messages",
        },
        text: {
          type: "string" as const,
          description: "Message text to send",
        },
        replyTo: {
          type: "string" as const,
          description: "Message ID to reply to (optional)",
        },
        limit: {
          type: "number" as const,
          description: "Number of messages to fetch (default 20)",
        },
        onBehalfOf: {
          type: "string" as const,
          description:
            'DID to act on behalf of (agent delegation), or "self" to act as the agent itself with no delegation (#1545). The agent must have role:agent membership on the target DID.',
        },
      },
      required: ["action"],
    },
    async execute(
      _id: string,
      params: {
        action: string;
        to?: string;
        text?: string;
        replyTo?: string;
        limit?: number;
        onBehalfOf?: string;
      },
    ): Promise<ToolResult> {
      if (params.onBehalfOf && params.onBehalfOf !== "self" && !validateDid(params.onBehalfOf)) {
        return errorResult(`Invalid DID format for onBehalfOf: ${params.onBehalfOf}`);
      }
      try {
        switch (params.action) {
          case "send_dm": {
            if (!params.to) return errorResult("'to' (recipient DID) is required");
            if (!params.text) return errorResult("'text' is required");
            const msg = await chat.sendDM(
              params.to,
              params.text,
              params.replyTo,
              params.onBehalfOf,
            );
            return jsonResult(msg);
          }
          case "get_dms": {
            if (!params.to) return errorResult("'to' (recipient DID) is required");
            const result = await chat.getDMs(params.to, { limit: params.limit || 20 });
            if (!result.messages.length) return textResult("No DMs found");
            return jsonResult({
              messages: truncateResults(result.messages),
              hasMore: result.hasMore,
            });
          }
          case "list_conversations": {
            const convs = await chat.listConversations();
            if (!convs.length) return textResult("No conversations found");
            return jsonResult(truncateResults(convs));
          }
          case "send": {
            if (!params.to) return errorResult("'to' (conversation DID) is required");
            if (!params.text) return errorResult("'text' is required");
            const msg = await chat.sendMessage(params.to, params.text, {
              replyToMessageId: params.replyTo,
              onBehalfOf: params.onBehalfOf,
            });
            return jsonResult(msg);
          }
          case "get_messages": {
            if (!params.to) return errorResult("'to' (conversation DID) is required");
            const result = await chat.getMessages(params.to, { limit: params.limit || 20 });
            if (!result.messages.length) return textResult("No messages found");
            return jsonResult({
              messages: truncateResults(result.messages),
              hasMore: result.hasMore,
            });
          }
          default:
            return errorResult(`Unknown action: ${params.action}`);
        }
      } catch (err: unknown) {
        return errorResult(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
