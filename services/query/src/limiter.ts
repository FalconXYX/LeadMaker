// Admission control for search: at most `concurrency` statements run, up to `maxQueue` wait (each for at most
// `maxWaitMs`), and the rest are refused at once with 503, so overload sheds load instead of growing latency.
import { ClientClosedError } from './db.ts';
import { busy } from './errors.ts';

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  done: () => void;
}

export interface LimiterOptions {
  concurrency: number;
  maxQueue: number;
  maxWaitMs: number;
}

export class Limiter {
  readonly opts: LimiterOptions;
  private active = 0;
  private readonly queue: Waiter[] = [];
  rejected = 0;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
  }

  get running(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new ClientClosedError());
    if (this.active < this.opts.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.opts.maxQueue) {
      this.rejected++;
      return Promise.reject(busy());
    }
    return new Promise<void>((resolve, reject) => {
      const leave = (err: Error) => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        waiter.done();
        reject(err);
      };
      const onAbort = () => leave(new ClientClosedError());
      const timer = setTimeout(() => {
        this.rejected++;
        leave(busy());
      }, this.opts.maxWaitMs);
      const waiter: Waiter = {
        resolve,
        reject,
        done: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (!next) {
      this.active--;
      return;
    }
    next.done();
    next.resolve();
  }
}
