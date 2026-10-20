import { readFile } from "node:fs/promises";
import { saveJson } from "./cursor.js";
import { digest, record, type StepRequest } from "./model.js";

type DeliveryResult = "ack" | "retry" | "dead-letter";
interface DeadLetter {
  request: StepRequest;
  httpStatus: number;
  rejectedAt: string;
}
interface DeadLetterFile {
  version: 1;
  entries: Record<string, DeadLetter>;
}
/** Only explicit receipt markers count; a generic conflict is not an ack. */
function alreadyApplied(body: string): boolean {
  if (body.trim() === "already applied") return true;
  try {
    const receipt = record(JSON.parse(body));
    return receipt.code === "already_applied" || receipt.error === "already applied";
  } catch {
    return false;
  }
}
/** Bound untrusted receipt reads and discard them; never log or persist bodies. */
async function receiptBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  async function next(): Promise<string> {
    const chunk = await reader!.read();
    if (chunk.done) return Buffer.concat(chunks).toString("utf8");
    size += chunk.value.byteLength;
    if (size > 4096) return "";
    chunks.push(chunk.value);
    return next();
  }
  try {
    return await next();
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function deliveryResult(response: Response): Promise<DeliveryResult> {
  if (response.ok) {
    await response.body?.cancel();
    return "ack";
  }
  const permanent = response.status >= 400 && response.status < 500
    && response.status !== 408 && response.status !== 429;
  if (!permanent) {
    await response.body?.cancel();
    return "retry";
  }
  return alreadyApplied(await receiptBody(response)) ? "ack" : "dead-letter";
}
/**
 * Persist before removing the outbox head. A crash between these writes may
 * revisit the rejection; the exact signed request hash makes that idempotent.
 */
export async function saveDeadLetter(path: string, request: StepRequest, httpStatus: number, at: number): Promise<void> {
  let file: DeadLetterFile = { version: 1, entries: {} };
  try {
    const stored = record(JSON.parse(await readFile(path, "utf8")));
    if (stored.version !== 1) throw new Error("invalid dead-letter version");
    file = { version: 1, entries: record(stored.entries) as DeadLetterFile["entries"] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = digest(request);
  if (Object.hasOwn(file.entries, id)) return;
  file.entries[id] = { request, httpStatus, rejectedAt: new Date(at).toISOString() };
  await saveJson(path, file);
}
export function rejectedStepWarning(request: StepRequest, status: number): string {
  const id = request.payload.stepId;
  const safeId = /^horizon:[0-9a-f]{32}$/.test(id) ? id : "[invalid-step-id]";
  return `[imajin-horizon] stepId=${safeId} dead-lettered (HTTP ${status}); continuing outbox`;
}
