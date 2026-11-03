import type { AssistantMessage, AssistantMessageEvent } from "openclaw/plugin-sdk/llm";

/** CI has no OpenClaw peer: only the SDK queue/result contract is reproduced. */
export function createAssistantMessageEventStream() {
  const queue: AssistantMessageEvent[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  let finish!: (message: AssistantMessage) => void;
  const result = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
  return {
    push(event: AssistantMessageEvent) {
      queue.push(event);
      if (event.type === "error" || event.type === "done") {
        finish(event.type === "error" ? event.error : event.message);
        ended = true;
      }
      wake?.();
    },
    end() { ended = true; wake?.(); },
    result: () => result,
    async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      if (queue.length) yield queue.shift()!;
      else if (ended) return;
      else await new Promise<void>((resolve) => { wake = resolve; });
      yield* this[Symbol.asyncIterator]();
    },
  };
}
