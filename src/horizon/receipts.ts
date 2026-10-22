import { createHash } from "node:crypto";
import { canonicalize } from "../approval-bridge.js";
import type { createLoopTransport } from "../loop-publisher.js";
import { record, type StepRequest } from "./model.js";
import { receiptBody } from "./outbox.js";

// Kernel docs/loops-rail-contract.md (#2931): five-minute ingest age window.
const SIGNED_MESSAGE_MAX_AGE_MS = 5 * 60 * 1000;
export function isStale(request: StepRequest, at: number): boolean {
  const signedAt = Date.parse(request.payload.at);
  if (!Number.isFinite(signedAt)) throw new Error("invalid outbox timestamp");
  return at - signedAt > SIGNED_MESSAGE_MAX_AGE_MS;
}
/** Hash the parsed original ingest request, not its HTTP JSON or cursor metadata. */
export function envelopeHash(request: StepRequest): string {
  const { type, payload, publisherDid, signature } = request;
  const parsed = {
    type, payload, publisherDid,
    signature: {
      keyId: signature.keyId.toLowerCase(), alg: signature.alg, sig: signature.sig.toLowerCase(),
    },
  };
  return createHash("sha256").update(canonicalize(parsed), "utf8").digest("hex");
}
export type ReceiptResult = "accepted" | "not_found" | "unavailable";
export async function lookupReceipt(
  transport: Pick<ReturnType<typeof createLoopTransport>, "receipt">,
  request: StepRequest,
  at: number,
): Promise<ReceiptResult> {
  try {
    const hash = envelopeHash(request);
    const response = await transport.receipt({
      loopId: request.payload.loopId, principal: request.payload.principal,
      envelopeHash: hash, at: new Date(at).toISOString(),
    });
    const body = record(JSON.parse(await receiptBody(response)));
    if (response.status === 200 && body.status === "accepted" && body.eventId === `signed-loop:${hash}`) {
      return "accepted";
    }
    if (response.status === 404 && body.status === "not_found") return "not_found";
  } catch {
    // Auth failures, invalid/unreadable receipts and outages are never acceptance.
  }
  return "unavailable";
}
