export interface Place {
  /** Higher goes first. Ties keep the order they arrived in. */
  priority?: number;
  /** What `reweigh` knows the caller by. */
  id?: string;
  /** Called once, when the caller has to wait. */
  onQueue?: () => void;
}

interface Waiter {
  priority: number;
  seq: number;
  id?: string;
  turn: () => void;
}

/**
 * Lets at most `limit` callers through at once and queues the rest, the
 * highest priority first. A caller that gives up while queued is dropped from
 * the queue, so a page scrolled past does not leave work waiting for a turn
 * nobody wants.
 */
export class Gate {
  private held = 0;
  private queue: Waiter[] = [];
  private limit: number;
  private seq = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** A release, once there is room. Rejects if `signal` aborts before then. */
  enter(signal: AbortSignal, { priority = 0, id, onQueue }: Place = {}): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const admit = () => {
        this.held++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.held--;
          if (this.held < this.limit) this.next();
        });
      };
      if (this.held < this.limit) return admit();
      const waiter: Waiter = {
        priority, seq: this.seq++, id,
        turn: () => {
          signal.removeEventListener('abort', leave);
          admit();
        },
      };
      const leave = () => {
        this.queue = this.queue.filter((w) => w !== waiter);
        reject(signal.reason);
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', leave, { once: true });
      this.sort();
      onQueue?.();
    });
  }

  /** Moves a queued caller up or down. One already let through is left alone. */
  reweigh(id: string, priority: number): void {
    for (const waiter of this.queue) if (waiter.id === id) waiter.priority = priority;
    this.sort();
  }

  private next(): void {
    this.queue.shift()?.turn();
  }

  private sort(): void {
    this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
  }
}
