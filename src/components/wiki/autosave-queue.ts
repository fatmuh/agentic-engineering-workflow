/** Debounced writes, always serialized so an older request cannot win last. */
export class AutosaveQueue<T> {
  private latest: string;
  private saved: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor(
    initial: string,
    private write: (snapshot: string) => Promise<T>,
    private onSaved: (result: T) => void,
    private onError: (error: unknown) => void,
    private onPending: (pending: boolean) => void,
    private delay = 700,
  ) {
    this.latest = this.saved = initial;
  }

  get pending(): boolean {
    return this.latest !== this.saved || this.running !== undefined;
  }

  enqueue(snapshot: string): void {
    if (snapshot === this.latest) return;
    this.latest = snapshot;
    clearTimeout(this.timer);
    this.onPending(this.pending);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = undefined;
      this.onPending(this.pending);
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    try {
      while (this.latest !== this.saved) {
        const snapshot = this.latest;
        const result = await this.write(snapshot);
        this.saved = snapshot;
        this.onSaved(result);
      }
    } catch (error) {
      // Keep the latest draft dirty; retry never reverts to a failed snapshot.
      this.onError(error);
    }
  }
}
