import { createHash } from "node:crypto";
import type { LoopEnvelope, LoopIngestRequest } from "../loop-publisher.js";

export type StepType = "step.queued" | "step.updated" | "step.finished" | "step.observed" | "step.attested";
export interface StepEnvelope extends LoopEnvelope {
  stepId: string;
  [key: string]: unknown;
}
export type StepRequest = LoopIngestRequest<StepType, StepEnvelope>;
export interface StepFact {
  type: StepType;
  data: Record<string, unknown>;
}
export interface HorizonItem {
  id: string;
  zone: "head" | "near" | "middle" | "tail" | "past";
  title: string;
  refs: string[];
  addedAt: string;
  movedAt?: string;
  pr?: string | number;
  prDraft?: boolean;
  waitingOn?: string[];
  closed?: boolean;
  stepKind?: "code" | "human" | "ops";
  attestorDid?: string;
  outcome?: string;
  briefRef?: string;
  provisionRef?: string;
  designRef?: string;
  release?: { issue: string; mergeCommit: string; tag: string };
  deployment?: { tag: string; environment: "prod" };
  attestation?: string;
}
export interface HorizonFile {
  depthTarget: number;
  items: HorizonItem[];
}
export interface MappingContext {
  loopId: string;
  did: string;
  repository: string;
}
export interface MappedItem {
  stepId: string;
  declaration: Record<string, unknown>;
  update: Record<string, unknown>;
  facts: Record<string, StepFact>;
  refs: { issue?: string; pr?: string };
}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function deriveStepId(loopId: string, did: string, itemId: string): string {
  return `horizon:${digest([loopId, did, itemId]).slice(0, 32)}`;
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error("invalid text");
  // Fail closed instead of leaking credential-shaped free text into signed facts or cursor.
  if (/-----BEGIN |(?:Bearer|Basic)\s+\S+|\b(?:sk-|gh[pousr]_|github_pat_|glpat-|xox[baprs]-)\S+|\b(?:password|secret|token|api[_-]?key|private[_-]?key)\s*[=:]|\w+:\/\/[^/\s]+@/i.test(value)) {
    throw new Error("credential-shaped text");
  }
  return value;
}
function timestamp(value: unknown): void {
  if (!Number.isFinite(Date.parse(text(value)))) throw new Error("invalid timestamp");
}
function texts(value: unknown): void {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid list");
  value.forEach(text);
}
function optionalTexts(item: Record<string, unknown>): void {
  for (const field of ["outcome", "briefRef", "provisionRef", "designRef", "attestation", "attestorDid"]) {
    if (item[field] !== undefined) text(item[field]);
  }
  if (item.outcome !== undefined && !/^OUTCOME\b/u.test(String(item.outcome))) throw new Error("invalid outcome");
  if (item.attestorDid !== undefined && !/^did:[^\s:]+:\S+$/.test(String(item.attestorDid))) throw new Error("invalid attestor");
}
function validateEvidence(item: Record<string, unknown>): void {
  if (item.release !== undefined) {
    const release = record(item.release);
    text(release.issue);
    text(release.tag);
    if (!/^[0-9a-f]{40}$/i.test(String(release.mergeCommit))) throw new Error("invalid commit");
  }
  if (item.deployment !== undefined) {
    const deployment = record(item.deployment);
    text(deployment.tag);
    if (deployment.environment !== "prod") throw new Error("invalid environment");
  }
}
function validateItem(value: unknown): HorizonItem {
  const item = record(value);
  text(item.id);
  text(item.title);
  timestamp(item.addedAt);
  if (!["head", "near", "middle", "tail", "past"].includes(String(item.zone))) throw new Error("invalid zone");
  texts(item.refs);
  if (item.waitingOn !== undefined) texts(item.waitingOn);
  if (item.movedAt !== undefined) timestamp(item.movedAt);
  for (const field of ["closed", "prDraft"]) {
    if (item[field] !== undefined && typeof item[field] !== "boolean") throw new Error("invalid flag");
  }
  if (item.pr !== undefined && !(typeof item.pr === "number" && Number.isSafeInteger(item.pr) && item.pr > 0)) text(item.pr);
  if (item.stepKind !== undefined && !["code", "human", "ops"].includes(String(item.stepKind))) throw new Error("invalid kind");
  optionalTexts(item);
  validateEvidence(item);
  return item as unknown as HorizonItem;
}
/** Validate the whole snapshot before any event is sent, including pending retries. */
export function parseHorizon(raw: string): HorizonFile {
  if (Buffer.byteLength(raw) > 1_048_576) throw new Error("horizon too large");
  const file = record(JSON.parse(raw));
  if (!Number.isInteger(file.depthTarget) || Number(file.depthTarget) < 1) throw new Error("invalid depth");
  if (!Array.isArray(file.items) || file.items.length > 1000) throw new Error("invalid items");
  const items = file.items.map(validateItem);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("duplicate ids");
  return { depthTarget: Number(file.depthTarget), items };
}
export function issueRef(value: string, repository: string): string | undefined {
  if (/^#[1-9]\d*$/.test(value)) return `${repository}${value}`;
  if (/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(value)) return value;
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)$/.exec(value);
  return url ? `${url[1]}#${url[2]}` : undefined;
}
function prRef(value: string | number | undefined, repository: string): string | undefined {
  if (value === undefined) return undefined;
  if (/^#?[1-9]\d*$/.test(String(value))) return `https://github.com/${repository}/pull/${String(value).replace("#", "")}`;
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/.test(String(value))) return String(value);
  throw new Error("invalid PR ref");
}
/** Local zone is a hint only. Never publish zone/depth or fabricate a claim. */
export function mapItem(item: HorizonItem, rank: number, context: MappingContext): MappedItem {
  const stepId = deriveStepId(context.loopId, context.did, item.id);
  const issue = item.refs.map(ref => issueRef(ref, context.repository)).find(Boolean);
  const pr = prRef(item.pr, context.repository);
  const repository = issue?.split("#")[0] ?? context.repository;
  const stepKind = item.stepKind ?? (issue || pr ? "code" : "ops");
  const conditions = stepKind === "code"
    ? ["issue_closed", "release_contains", "deployed"].map(kind => ({ id: kind, kind }))
    : [{ id: "attestation", kind: "attestation", attestorDid: item.attestorDid ?? context.did }];
  const declaration = {
    stepKind, intention: item.title, rank,
    ...(stepKind === "code" ? { repository } : {}),
    exitConditions: conditions,
  };
  const update: Record<string, unknown> = { rank, intention: item.title };
  if (issue && item.outcome) update.issue = { ref: issue, outcome: item.outcome };
  for (const key of ["briefRef", "provisionRef", "designRef"] as const) {
    if (item[key]) update[key] = item[key];
  }
  const facts: Record<string, StepFact> = {};
  if (item.zone === "past" || item.closed) {
    facts.finished = { type: "step.finished", data: {} };
    if (stepKind === "code" && issue) facts.closed = {
      type: "step.observed",
      data: { observation: { conditionId: "issue_closed", evidence: { kind: "issue_closed", issue } } },
    };
  }
  if (item.release) {
    if (stepKind !== "code" || issueRef(item.release.issue, repository) !== issue) throw new Error("release issue mismatch");
    facts.release = { type: "step.observed", data: { observation: {
      conditionId: "release_contains", evidence: {
        kind: "release_contains", repository, mergeCommit: item.release.mergeCommit, tag: item.release.tag, issue,
      },
    } } };
  }
  if (item.deployment) {
    if (stepKind !== "code") throw new Error("deployment on non-code step");
    facts.deployment = { type: "step.observed", data: { observation: {
      conditionId: "deployed", evidence: { kind: "deployed", repository, tag: item.deployment.tag, environment: "prod" },
    } } };
  }
  if (item.attestation) {
    if (stepKind === "code" || (item.attestorDid ?? context.did) !== context.did) throw new Error("cannot attest for another DID");
    facts.attestation = { type: "step.attested", data: { attestation: {
      conditionId: "attestation", did: context.did, statement: item.attestation,
    } } };
  }
  return { stepId, declaration, update, facts, refs: { ...(issue ? { issue } : {}), ...(pr ? { pr } : {}) } };
}
