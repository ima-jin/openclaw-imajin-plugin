import { readFile } from "node:fs/promises";

export type SignerType = "human" | "agent";
export type GatewayApprovalKind = "exec" | "plugin";
export type GatewayApprovalDecision = "approve" | "reject";

export interface SignedMessage<T> {
  from: string;
  type: SignerType;
  timestamp: number;
  payload: T;
  signature: string;
}

export interface GatewayApprovalRequest {
  requestId: string;
  kind: GatewayApprovalKind;
  summary: string;
  requesterDid: string;
  expiresAt: string;
}

export interface ApprovalRequestedPayload extends GatewayApprovalRequest {}

export interface ApprovalDecisionPayload {
  requestId: string;
  decision: GatewayApprovalDecision;
}

export const APPROVAL_REQUESTED_FRAME_TYPE = "openclaw.approval.requested" as const;
export const APPROVAL_DECISION_FRAME_TYPE = "approval.decision" as const;

export interface ApprovalRequestedFrame {
  type: typeof APPROVAL_REQUESTED_FRAME_TYPE;
  attestation: SignedMessage<ApprovalRequestedPayload>;
}

export interface ApprovalDecisionFrame {
  type: typeof APPROVAL_DECISION_FRAME_TYPE;
  requestId: string;
  attestation: SignedMessage<ApprovalDecisionPayload>;
}

export interface PendingApprovalRequest {
  requestId: string;
  expiresAtMs: number;
  kind: GatewayApprovalKind;
}

export type ApprovalRejectionReason =
  | "unsigned"
  | "invalid_signature"
  | "request_id_mismatch"
  | "expired";

export type ApprovalVerificationResult =
  | { ok: true; requestId: string; decision: GatewayApprovalDecision; approverDid: string }
  | { ok: false; reason: ApprovalRejectionReason };

interface Logger {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface ApprovalBridgeConfig {
  did: string;
  keypairPath: string;
  pinnedApproverPublicKeyHex: string;
}

interface RequesterKeypair {
  did: string;
  privateKeyHex: string;
}

export type ApprovalResolvedHandler = (
  requestId: string,
  decision: GatewayApprovalDecision,
  kind: GatewayApprovalKind,
) => void | Promise<void>;

function hexToBytes(hex: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) {
    throw new Error("invalid hex string");
  }
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadEd25519() {
  const ed = await import("@noble/ed25519");
  const { sha512 } = await import("@noble/hashes/sha2.js");
  if ("hashes" in ed && ed.hashes) {
    (ed.hashes as { sha512?: typeof sha512 }).sha512 = sha512;
  } else {
    try {
      ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
        sha512(ed.etc.concatBytes(...messages));
    } catch {
      // A host may have configured the hash implementation already.
    }
  }
  return ed;
}

/** Mirrors @imajin/auth canonical JSON so signatures verify across repositories. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
      .join(",")}}`;
  }
  return String(value);
}

function isSignedMessage(value: unknown): value is SignedMessage<unknown> {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    typeof message.from === "string" &&
    message.from.length > 0 &&
    (message.type === "human" || message.type === "agent") &&
    typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp) &&
    typeof message.signature === "string" &&
    message.signature.length > 0 &&
    "payload" in message
  );
}

export async function signMessage<T>(
  payload: T,
  signer: { did: string; type: SignerType; privateKeyHex: string },
): Promise<SignedMessage<T>> {
  const unsigned = { from: signer.did, type: signer.type, timestamp: Date.now(), payload };
  const ed = await loadEd25519();
  const signature = await ed.signAsync(
    new TextEncoder().encode(canonicalize(unsigned)),
    hexToBytes(signer.privateKeyHex),
  );
  return { ...unsigned, signature: bytesToHex(signature) };
}

export async function verifyMessage(
  message: unknown,
  publicKeyHex: string,
): Promise<boolean> {
  if (!isSignedMessage(message)) return false;
  try {
    const { signature, ...unsigned } = message;
    const ed = await loadEd25519();
    return await ed.verifyAsync(
      hexToBytes(signature),
      new TextEncoder().encode(canonicalize(unsigned)),
      hexToBytes(publicKeyHex),
    );
  } catch {
    return false;
  }
}

export function isApprovalDecisionFrame(frame: unknown): frame is ApprovalDecisionFrame {
  if (!frame || typeof frame !== "object") return false;
  const value = frame as Record<string, unknown>;
  return (
    value.type === APPROVAL_DECISION_FRAME_TYPE &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    typeof value.attestation === "object" &&
    value.attestation !== null
  );
}

export async function buildApprovalRequestedFrame(
  request: GatewayApprovalRequest,
  signer: { did: string; privateKeyHex: string },
): Promise<ApprovalRequestedFrame> {
  const attestation = await signMessage(request, {
    did: signer.did,
    type: "agent",
    privateKeyHex: signer.privateKeyHex,
  });
  return { type: APPROVAL_REQUESTED_FRAME_TYPE, attestation };
}

/**
 * Verifies signature trust before consulting any decision fields. The outer
 * WS frame is only a routing hint; both request ID and decision must be signed.
 */
export async function verifyApprovalDecision(
  frame: unknown,
  pending: PendingApprovalRequest,
  pinnedApproverPublicKeyHex: string,
  nowMs: number = Date.now(),
): Promise<ApprovalVerificationResult> {
  if (!isApprovalDecisionFrame(frame) || !isSignedMessage(frame.attestation)) {
    return { ok: false, reason: "unsigned" };
  }
  const payload = frame.attestation.payload as Partial<ApprovalDecisionPayload> | undefined;
  if (
    !payload ||
    typeof payload.requestId !== "string" ||
    (payload.decision !== "approve" && payload.decision !== "reject")
  ) {
    return { ok: false, reason: "unsigned" };
  }
  if (!(await verifyMessage(frame.attestation, pinnedApproverPublicKeyHex))) {
    return { ok: false, reason: "invalid_signature" };
  }
  if (frame.requestId !== pending.requestId || payload.requestId !== pending.requestId) {
    return { ok: false, reason: "request_id_mismatch" };
  }
  if (nowMs >= pending.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    requestId: payload.requestId,
    decision: payload.decision,
    approverDid: frame.attestation.from,
  };
}

export class ApprovalBridge {
  private keypair: RequesterKeypair | null = null;
  private readonly pending = new Map<string, PendingApprovalRequest>();
  private resolvedHandler: ApprovalResolvedHandler | undefined;
  private readonly logger: Logger;

  constructor(
    private readonly config: ApprovalBridgeConfig,
    private readonly send: (frame: unknown) => void,
    logger?: Logger,
  ) {
    this.logger = logger ?? {
      info: (message, ...args) => console.log(`[imajin-approval] ${message}`, ...args),
      warn: (message, ...args) => console.warn(`[imajin-approval] ${message}`, ...args),
      error: (message, ...args) => console.error(`[imajin-approval] ${message}`, ...args),
    };
  }

  onResolved(handler: ApprovalResolvedHandler): void {
    this.resolvedHandler = handler;
  }

  async publishRequest(request: GatewayApprovalRequest): Promise<void> {
    const expiresAtMs = Date.parse(request.expiresAt);
    if (!request.requestId || !Number.isFinite(expiresAtMs)) {
      throw new Error("approval bridge: requestId and a valid expiresAt are required");
    }
    const frame = await buildApprovalRequestedFrame(request, await this.loadKeypair());
    this.pending.set(request.requestId, {
      requestId: request.requestId,
      expiresAtMs,
      kind: request.kind,
    });
    try {
      this.send(frame);
    } catch (error) {
      this.pending.delete(request.requestId);
      throw error;
    }
    this.logger.info(`published ${request.kind} approval request ${request.requestId}`);
  }

  async handleFrame(frame: unknown): Promise<void> {
    if (!isApprovalDecisionFrame(frame)) return;
    const pending = this.pending.get(frame.requestId);
    if (!pending) {
      this.logger.warn(`rejected decision for unknown request ${frame.requestId}`);
      return;
    }

    const result = await verifyApprovalDecision(
      frame,
      pending,
      this.config.pinnedApproverPublicKeyHex,
    );
    if (!result.ok) {
      this.logger.warn(`rejected decision for ${frame.requestId}: ${result.reason}`);
      if (result.reason === "expired") this.pending.delete(frame.requestId);
      return;
    }

    this.pending.delete(result.requestId);
    this.logger.info(
      `verified decision for ${result.requestId} from ${result.approverDid}`,
    );
    try {
      await this.resolvedHandler?.(result.requestId, result.decision, pending.kind);
    } catch (error) {
      this.logger.error(`failed to resolve ${result.requestId}`, error);
    }
  }

  pruneExpired(nowMs: number = Date.now()): void {
    for (const [requestId, pending] of this.pending) {
      if (nowMs >= pending.expiresAtMs) {
        this.pending.delete(requestId);
        this.logger.warn(`pruned expired request ${requestId}`);
      }
    }
  }

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  private async loadKeypair(): Promise<RequesterKeypair> {
    if (this.keypair) return this.keypair;
    const parsed = JSON.parse(await readFile(this.config.keypairPath, "utf-8")) as {
      did?: string;
      privateKey?: string;
      keypair?: { privateKey?: string };
    };
    const did = this.config.did || parsed.did;
    const privateKeyHex = parsed.privateKey || parsed.keypair?.privateKey || "";
    if (!did || !privateKeyHex) {
      throw new Error("approval bridge: keypair file missing did/privateKey");
    }
    this.keypair = { did, privateKeyHex };
    return this.keypair;
  }
}
