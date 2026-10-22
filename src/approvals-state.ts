import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ApprovalSourceRequest } from "./sources/types.js";
import type { ImajinCatalogProposalState } from "./sources/imajin-catalog.js";

export const APPROVALS_STATE_FILENAME = "approvals-bridge-state.json";

export interface StoredApprovalProposal {
  sourceId: string;
  owner?: NonNullable<ApprovalSourceRequest["owner"]>;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
  sourceRevision: string;
  contentHash: string;
  expiresAtMs?: number;
}

function isStoredProposal(value: unknown): value is StoredApprovalProposal {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<StoredApprovalProposal>;
  return typeof p.sourceId === "string" && typeof p.kind === "string" &&
    typeof p.summary === "string" && typeof p.sourceRevision === "string" &&
    typeof p.contentHash === "string" && /^sha256:[0-9a-f]{64}$/.test(p.contentHash) &&
    (p.expiresAtMs === undefined || Number.isFinite(p.expiresAtMs)) &&
    (p.detail === undefined || (!!p.detail && typeof p.detail === "object" && !Array.isArray(p.detail)));
}

/** Scoped, best-effort state, alongside the existing durable catch-up cursor. */
export class ApprovalsStateStore {
  readonly proposals = new Map<string, StoredApprovalProposal>();
  readonly warnings = new Set<string>();
  readonly outcomes = new Map<string, "applied" | "expired/superseded">();
  readonly catalog: ImajinCatalogProposalState = { revision: null, proposalId: null, dismissed: false };
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string | undefined,
    private readonly scope: { nodeUrl: string; agentDid: string; operatorDid: string },
    private readonly logger: Pick<Console, "error"> = console,
  ) {}

  async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const state = JSON.parse(await readFile(this.filePath, "utf-8"));
      if (state.version !== 1 || Object.entries(this.scope).some(([key, value]) => state[key] !== value)) return;
      for (const [id, proposal] of Object.entries(state.proposals ?? {})) {
        if (isStoredProposal(proposal)) this.proposals.set(id, proposal);
      }
      for (const key of state.warnings ?? []) {
        if (typeof key === "string") this.warnings.add(key);
      }
      for (const [id, outcome] of Object.entries(state.outcomes ?? {})) {
        if (outcome === "applied" || outcome === "expired/superseded") this.outcomes.set(id, outcome);
      }
      const catalog = state.catalog;
      if (catalog && typeof catalog.revision === "string" && /^[0-9a-f]{64}$/.test(catalog.revision) &&
          typeof catalog.proposalId === "string" && /^imajin-catalog:[0-9a-f-]{36}$/.test(catalog.proposalId) &&
          typeof catalog.dismissed === "boolean") {
        Object.assign(this.catalog, catalog);
      }
    } catch {
      // First boot, foreign or corrupt state: live source reads remain authoritative.
    }
  }

  persist(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    const filePath = this.filePath;
    const data = JSON.stringify({
      version: 1, ...this.scope,
      proposals: Object.fromEntries(this.proposals),
      warnings: [...this.warnings],
      outcomes: Object.fromEntries(this.outcomes),
      catalog: this.catalog,
    });
    this.writes = this.writes.then(async () => {
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const temp = `${filePath}.${randomUUID()}.tmp`;
        await writeFile(temp, data, { encoding: "utf-8", mode: 0o600 });
        await rename(temp, filePath);
      } catch (err) {
        this.logger.error(`[imajin-approvals-bridge] failed to persist bridge state: ${String(err)}`);
      }
    });
    return this.writes;
  }
}
