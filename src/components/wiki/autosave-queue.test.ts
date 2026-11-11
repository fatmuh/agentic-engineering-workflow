import { afterEach, describe, expect, it, vi } from "vitest";
import { AutosaveQueue } from "./autosave-queue";

afterEach(() => vi.useRealTimers());

describe("Wiki autosave", () => {
  it("does not save an untouched document and debounces edits", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (value: string) => value);
    const queue = new AutosaveQueue("initial", write, vi.fn(), vi.fn(), vi.fn());
    queue.enqueue("initial");
    await vi.runAllTimersAsync();
    expect(write).not.toHaveBeenCalled();
    queue.enqueue("first");
    queue.enqueue("latest");
    await vi.advanceTimersByTimeAsync(700);
    expect(write).toHaveBeenCalledExactlyOnceWith("latest");
    expect(queue.pending).toBe(false);
  });

  it("serializes in-flight writes and drains the newest draft", async () => {
    let finish!: (value: string) => void;
    const write = vi.fn((value: string) => value === "first"
      ? new Promise<string>(resolve => { finish = resolve; })
      : Promise.resolve(value));
    const saved = vi.fn();
    const queue = new AutosaveQueue("initial", write, saved, vi.fn(), vi.fn());
    queue.enqueue("first");
    const pending = queue.flush();
    queue.enqueue("second");
    queue.enqueue("latest");
    expect(write).toHaveBeenCalledTimes(1);
    finish("first");
    await pending;
    expect(write.mock.calls.map(([value]) => value)).toEqual(["first", "latest"]);
    expect(saved).toHaveBeenLastCalledWith("latest");
    expect(queue.pending).toBe(false);
    await queue.flush();
  });

  it("keeps failed changes dirty and retries the newest snapshot", async () => {
    const write = vi.fn<(value: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async value => value);
    const error = vi.fn();
    const queue = new AutosaveQueue("initial", write, vi.fn(), error, vi.fn());
    queue.enqueue("failed");
    await queue.flush();
    expect(queue.pending).toBe(true);
    expect(error).toHaveBeenCalledOnce();
    queue.enqueue("recovered");
    await queue.flush();
    expect(write).toHaveBeenLastCalledWith("recovered");
    expect(queue.pending).toBe(false);
  });
});
