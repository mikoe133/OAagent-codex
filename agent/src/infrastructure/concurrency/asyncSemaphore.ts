export type AsyncSemaphoreMetrics = {
  active: number;
  pending: number;
  peakActive: number;
};

type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class AsyncSemaphore {
  private active = 0;
  private peakActive = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("并发数必须是正整数。");
    }
  }

  get metrics(): AsyncSemaphoreMetrics {
    return {
      active: this.active,
      pending: this.waiters.length,
      peakActive: this.peakActive,
    };
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (this.active < this.concurrency) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return Promise.resolve(this.createRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) };
      this.waiters.push(waiter);
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) {
            this.waiters.splice(index, 1);
          }
          reject(signal.reason);
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
        if (signal.aborted) {
          waiter.onAbort();
        }
      }
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.active -= 1;
      this.startNext();
    };
  }

  private startNext(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      return;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.signal?.aborted) {
      waiter.reject(waiter.signal.reason);
      this.startNext();
      return;
    }
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    waiter.resolve(this.createRelease());
  }
}
