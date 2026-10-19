import { describe, expect, it } from "vitest";
import { deliveryResult, rejectedStepWarning } from "./outbox.js";
import type { StepRequest } from "./model.js";

describe("outbox delivery receipts", () => {
  it.each([
    JSON.stringify({ code: "already_applied" }),
    JSON.stringify({ error: "already applied" }),
    "already applied",
  ])("acks an explicit already-applied response", async body => {
    expect(await deliveryResult(new Response(body, { status: 409 }))).toBe("ack");
  });
  it.each([
    JSON.stringify({ code: "loop_owner_conflict" }),
    JSON.stringify({ error: "not already applied" }),
    JSON.stringify({ message: "already applied" }),
    "{broken",
    "",
  ])("does not mistake an arbitrary conflict for a receipt", async body => {
    expect(await deliveryResult(new Response(body, { status: 409 }))).toBe("dead-letter");
  });
  it("limits receipt reads and cancels the response stream without logging the body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(4097)));
      },
      cancel() { cancelled = true; },
    }), { status: 409 });
    expect(await deliveryResult(response)).toBe("dead-letter");
    expect(cancelled).toBe(true);
  });
  it("handles chunked receipts and unreadable error bodies", async () => {
    const parts = ['{"code":', '"already_applied"}'];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts.shift();
        if (part) controller.enqueue(new TextEncoder().encode(part));
        else controller.close();
      },
    });
    expect(await deliveryResult(new Response(stream, { status: 409 }))).toBe("ack");
    const broken = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("unreadable response")); },
    });
    expect(await deliveryResult(new Response(broken, { status: 422 }))).toBe("dead-letter");
    expect(await deliveryResult(new Response(null, { status: 409 }))).toBe("dead-letter");
  });
  it("does not turn a transient failure into an acknowledgement based on its body", async () => {
    expect(await deliveryResult(new Response('{"code":"already_applied"}', { status: 503 }))).toBe("retry");
    expect(await deliveryResult(new Response(null, { status: 204 }))).toBe("ack");
  });
  it("never interpolates a corrupted cursor's free text into the step warning", () => {
    const request = { payload: { stepId: "unsafe\nfree text" } } as StepRequest;
    expect(rejectedStepWarning(request, 422)).toBe(
      "[imajin-horizon] stepId=[invalid-step-id] dead-lettered (HTTP 422); continuing outbox",
    );
  });
});
