import type { WakeHookContext } from "./wake-decision.js";

export interface WakeDisclosure {
  outcome: "completed" | "blocked";
  message: string;
}

export type WakeDisclosureSender = (ctx: WakeHookContext, disclosure: WakeDisclosure) => Promise<void>;

/** Host subagents disable the native message tool, not plugin tools. */
export function createWakeReportTool(ctx: WakeHookContext, send: WakeDisclosureSender) {
  return {
    name: "imajin_wake_report",
    label: "Report Warp wake outcome",
    description: "Send a real channel message to explicit reportTo targets or the configured directSend fallback. Use completed only with evidence that the job finished; otherwise use blocked and state what did not finish. Available only inside a tracked Warp wake or its decision subagents. Do not call again after disclosure.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["outcome", "message"],
      properties: {
        outcome: { type: "string", enum: ["completed", "blocked"] },
        message: { type: "string", minLength: 1, maxLength: 2_000 },
      },
    },
    async execute(_callId: string, params: WakeDisclosure) {
      if (!params || !["completed", "blocked"].includes(params.outcome)
        || typeof params.message !== "string" || !params.message.trim() || params.message.length > 2_000) {
        throw new Error("A bounded completed/blocked outcome disclosure is required");
      }
      await send(ctx, params);
      return { content: [{ type: "text", text: "Wake outcome delivered to the configured disclosure destination." }], details: { ok: true } };
    },
  };
}
