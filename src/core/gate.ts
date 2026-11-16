/**
 * Lets at most `limit` callers through at once and queues the rest in order.
 * A caller that gives up while queued is dropped from the queue, so a page
 * scrolled past does not leave work waiting for a turn nobody wants.
 */
export class Gate {
  private held = 0;
  private queue: (() => void)[] = [];
  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** A release, once there is room. Rejects if `signal` aborts before then. */
  enter(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const admit = () => {
        this.held++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.held--;
          if (this.held < this.limit) this.queue.shift()?.();
        });
      };
      if (this.held < this.limit) return admit();
      const leave = () => {
        this.queue = this.queue.filter((w) => w !== turn);
        reject(signal.reason);
      };
      const turn = () => {
        signal.removeEventListener('abort', leave);
        admit();
      };
      this.queue.push(turn);
      signal.addEventListener('abort', leave, { once: true });
    });
  }
}
