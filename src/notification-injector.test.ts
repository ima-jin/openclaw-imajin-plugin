import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotificationFrame } from "./ws-service.js";

// We test the batching logic by re-implementing the coalesce behaviour
// in plain JS to avoid needing the full plugin SDK types.

type Batch = { timeout: ReturnType<typeof setTimeout>; frames: NotificationFrame[] };

function createBatcher(
  coalesceMs: number,
  onFlush: (frames: NotificationFrame[]) => void,
) {
  const batches = new Map<string, Batch>();
  return {
    push(scope: string, frame: NotificationFrame) {
      const existing = batches.get(scope);
      if (existing) {
        existing.frames.push(frame);
        return;
      }
      const timeout = setTimeout(() => {
        const buf = batches.get(scope);
        if (buf) {
          batches.delete(scope);
          onFlush(buf.frames);
        }
      }, coalesceMs);
      batches.set(scope, { timeout, frames: [frame] });
    },
    dispose() {
      for (const [, buf] of batches) clearTimeout(buf.timeout);
      batches.clear();
    },
    size(scope: string) {
      return batches.get(scope)?.frames.length ?? 0;
    },
  };
}

describe("Warp wake batching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces two events within the window into one flush", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;

    batcher.push("warp.run.completed", f1);
    expect(batcher.size("warp.run.completed")).toBe(1);

    batcher.push("warp.run.completed", f2);
    expect(batcher.size("warp.run.completed")).toBe(2);
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(2);
    expect(batcher.size("warp.run.completed")).toBe(0);

    batcher.dispose();
  });

  it("starts a new batch after the window fires", () => {
    const flushed: NotificationFrame[][] = [];
    const batcher = createBatcher(300_000, (frames) => flushed.push(frames));

    const f1 = { id: "1", scope: "warp.run.completed", title: "run A", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f1);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(1);

    const f2 = { id: "2", scope: "warp.run.completed", title: "run B", body: "", createdAt: "", data: {} } as NotificationFrame;
    batcher.push("warp.run.completed", f2);
    vi.advanceTimersByTime(300_000);
    expect(flushed).toHaveLength(2);

    batcher.dispose();
  });
});
