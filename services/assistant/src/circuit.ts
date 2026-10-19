// Provider circuit breaker (§7.8): 3 API errors or timeouts within 60 s open it for 30 s, during which requests
// fail fast with ai_provider_down instead of waiting on a provider that is down. Per instance, in memory.
export interface CircuitOptions { threshold?: number; windowMs?: number; openMs?: number; now?: () => number }

export class CircuitBreaker {
  readonly #threshold: number;
  readonly #windowMs: number;
  readonly #openMs: number;
  readonly #now: () => number;
  #failures: number[] = [];
  #openUntil = 0;

  constructor(opts: CircuitOptions = {}) {
    this.#threshold = opts.threshold ?? 3;
    this.#windowMs = opts.windowMs ?? 60_000;
    this.#openMs = opts.openMs ?? 30_000;
    this.#now = opts.now ?? Date.now;
  }

  isOpen(): boolean {
    return this.#now() < this.#openUntil;
  }

  recordFailure(): void {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < this.#windowMs);
    this.#failures.push(now);
    if (this.#failures.length >= this.#threshold) {
      this.#openUntil = now + this.#openMs;
      this.#failures = [];
    }
  }

  recordSuccess(): void {
    this.#failures = [];
  }
}
