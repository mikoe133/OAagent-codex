import { performance } from "node:perf_hooks";

export type OaRequestLane = "p0" | "p1" | "p2" | "p3";

export type OaRequestExecutionOptions = {
  signal?: AbortSignal;
  maxWaitMs?: number;
};

export interface OaRequestExecutor {
  run<T>(
    lane: OaRequestLane,
    operation: () => Promise<T>,
    options?: OaRequestExecutionOptions,
  ): Promise<T>;
}

export type OaRequestSchedulerMetrics = {
  activeTotal: number;
  peakActiveTotal: number;
  pendingTotal: number;
  activeByLane: Record<OaRequestLane, number>;
  pendingByLane: Record<OaRequestLane, number>;
  rejected: number;
};

export class OaRequestQueueFullError extends Error {
  override name = "OaRequestQueueFullError";
}

export class OaRequestWaitTimeoutError extends Error {
  override name = "OaRequestWaitTimeoutError";
}

type Waiter = {
  id: number;
  lane: OaRequestLane;
  enqueuedAt: number;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timeout?: NodeJS.Timeout;
};

type SchedulerConfig = {
  totalConcurrency?: number;
  laneConcurrency?: Partial<Record<OaRequestLane, number>>;
  dataQueueCapacity?: number;
  p0MailboxCapacity?: number;
  fairnessMaxWaitMs?: number;
  maxQueueWaitMs?: number;
  now?: () => number;
};

const LANES: OaRequestLane[] = ["p0", "p1", "p2", "p3"];
const LANE_PRIORITY: Record<OaRequestLane, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
};

export class OaRequestScheduler implements OaRequestExecutor {
  private readonly totalConcurrency: number;
  private readonly laneConcurrency: Record<OaRequestLane, number>;
  private readonly dataQueueCapacity: number;
  private readonly p0MailboxCapacity: number;
  private readonly fairnessMaxWaitMs: number;
  private readonly maxQueueWaitMs: number;
  private readonly now: () => number;
  private readonly activeByLane = emptyLaneCounts();
  private readonly waiters: Waiter[] = [];
  private activeTotal = 0;
  private peakActiveTotal = 0;
  private rejected = 0;
  private nextWaiterId = 1;

  constructor(config: SchedulerConfig = {}) {
    this.totalConcurrency = positiveInteger(
      config.totalConcurrency ?? 4,
      "totalConcurrency",
    );
    this.laneConcurrency = {
      p0: positiveInteger(config.laneConcurrency?.p0 ?? 1, "laneConcurrency.p0"),
      p1: positiveInteger(config.laneConcurrency?.p1 ?? 1, "laneConcurrency.p1"),
      p2: positiveInteger(config.laneConcurrency?.p2 ?? 4, "laneConcurrency.p2"),
      p3: positiveInteger(config.laneConcurrency?.p3 ?? 1, "laneConcurrency.p3"),
    };
    this.dataQueueCapacity = nonNegativeInteger(
      config.dataQueueCapacity ?? 200,
      "dataQueueCapacity",
    );
    this.p0MailboxCapacity = positiveInteger(
      config.p0MailboxCapacity ?? 1,
      "p0MailboxCapacity",
    );
    this.fairnessMaxWaitMs = nonNegativeNumber(
      config.fairnessMaxWaitMs ?? 5_000,
      "fairnessMaxWaitMs",
    );
    this.maxQueueWaitMs = nonNegativeNumber(
      config.maxQueueWaitMs ?? 30_000,
      "maxQueueWaitMs",
    );
    this.now = config.now ?? (() => performance.now());
  }

  get metrics(): OaRequestSchedulerMetrics {
    const pendingByLane = emptyLaneCounts();
    for (const waiter of this.waiters) {
      pendingByLane[waiter.lane] += 1;
    }
    return {
      activeTotal: this.activeTotal,
      peakActiveTotal: this.peakActiveTotal,
      pendingTotal: this.waiters.length,
      activeByLane: { ...this.activeByLane },
      pendingByLane,
      rejected: this.rejected,
    };
  }

  async run<T>(
    lane: OaRequestLane,
    operation: () => Promise<T>,
    options: OaRequestExecutionOptions = {},
  ): Promise<T> {
    const release = await this.acquire(lane, options);
    try {
      options.signal?.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(
    lane: OaRequestLane,
    options: OaRequestExecutionOptions,
  ): Promise<() => void> {
    if (!LANES.includes(lane)) {
      return Promise.reject(new Error(`未知 OA request lane:${lane}`));
    }
    if (options.signal?.aborted) {
      return Promise.reject(options.signal.reason);
    }
    if (this.waiters.length === 0 && this.canStart(lane)) {
      return Promise.resolve(this.activate(lane));
    }
    if (!this.hasQueueCapacity(lane)) {
      this.rejected += 1;
      return Promise.reject(new OaRequestQueueFullError(
        lane === "p0" ? "OA P0 保留 mailbox 已满。" : "OA 数据等待队列已满。",
      ));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        id: this.nextWaiterId,
        lane,
        enqueuedAt: this.now(),
        resolve,
        reject,
        ...(options.signal ? { signal: options.signal } : {}),
      };
      this.nextWaiterId += 1;
      this.waiters.push(waiter);
      if (options.signal) {
        waiter.onAbort = () => {
          if (!this.removeWaiter(waiter)) {
            return;
          }
          this.cleanupWaiter(waiter);
          reject(options.signal?.reason);
          this.dispatch();
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      const maxWaitMs = options.maxWaitMs ?? this.maxQueueWaitMs;
      if (Number.isFinite(maxWaitMs)) {
        waiter.timeout = setTimeout(() => {
          if (!this.removeWaiter(waiter)) {
            return;
          }
          this.cleanupWaiter(waiter);
          reject(new OaRequestWaitTimeoutError(
            `OA ${lane} 请求等待超过 ${maxWaitMs}ms。`,
          ));
          this.dispatch();
        }, maxWaitMs);
        waiter.timeout.unref();
      }
      if (options.signal?.aborted) {
        waiter.onAbort?.();
        return;
      }
      this.dispatch();
    });
  }

  private hasQueueCapacity(lane: OaRequestLane): boolean {
    if (lane === "p0") {
      return this.waiters.filter((waiter) => waiter.lane === "p0").length <
        this.p0MailboxCapacity;
    }
    return this.waiters.filter((waiter) => waiter.lane !== "p0").length <
      this.dataQueueCapacity;
  }

  private canStart(lane: OaRequestLane): boolean {
    if (
      this.activeTotal >= this.totalConcurrency ||
      this.activeByLane[lane] >= this.laneConcurrency[lane]
    ) {
      return false;
    }
    if (lane === "p0") {
      return this.activeByLane.p1 === 0;
    }
    if (lane === "p1") {
      return this.activeByLane.p0 === 0;
    }
    return this.activeByLane.p0 === 0;
  }

  private activate(lane: OaRequestLane): () => void {
    this.activeTotal += 1;
    this.activeByLane[lane] += 1;
    this.peakActiveTotal = Math.max(this.peakActiveTotal, this.activeTotal);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.activeTotal -= 1;
      this.activeByLane[lane] -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.activeTotal < this.totalConcurrency) {
      const waiter = this.nextEligibleWaiter();
      if (!waiter) {
        return;
      }
      this.removeWaiter(waiter);
      this.cleanupWaiter(waiter);
      waiter.resolve(this.activate(waiter.lane));
    }
  }

  private nextEligibleWaiter(): Waiter | undefined {
    const eligible = this.waiters.filter((waiter) => this.canStart(waiter.lane));
    if (eligible.length === 0) {
      return undefined;
    }
    const p0 = eligible.filter((waiter) => waiter.lane === "p0");
    if (p0.length > 0) {
      return oldest(p0);
    }
    const now = this.now();
    const aged = eligible.filter(
      (waiter) => now - waiter.enqueuedAt >= this.fairnessMaxWaitMs,
    );
    if (aged.length > 0) {
      return oldest(aged);
    }
    return eligible.sort((left, right) =>
      LANE_PRIORITY[left.lane] - LANE_PRIORITY[right.lane] ||
      left.id - right.id
    )[0];
  }

  private removeWaiter(waiter: Waiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) {
      return false;
    }
    this.waiters.splice(index, 1);
    return true;
  }

  private cleanupWaiter(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    if (waiter.timeout) {
      clearTimeout(waiter.timeout);
    }
  }
}

function emptyLaneCounts(): Record<OaRequestLane, number> {
  return { p0: 0, p1: 0, p2: 0, p3: 0 };
}

function oldest(waiters: Waiter[]): Waiter {
  return waiters.reduce((selected, waiter) =>
    waiter.id < selected.id ? waiter : selected
  );
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} 必须是正整数。`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负整数。`);
  }
  return value;
}

function nonNegativeNumber(value: number, name: string): number {
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`${name} 必须是非负数。`);
  }
  return value;
}
