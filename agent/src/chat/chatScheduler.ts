export class ChatError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export type ChatLimits = {
  concurrency: number; userConcurrency: number; queue: number; userQueue: number;
  perMinute: number; queueMs: number; executionMs: number;
};
export function chatLimits(env: NodeJS.ProcessEnv = process.env): ChatLimits {
  const number = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    concurrency: number('CHAT_MAX_CONCURRENCY', 2), userConcurrency: number('CHAT_USER_CONCURRENCY', 1),
    queue: number('CHAT_MAX_QUEUE', 20), userQueue: number('CHAT_USER_QUEUE', 5),
    perMinute: number('CHAT_USER_REQUESTS_PER_MINUTE', 20),
    queueMs: number('CHAT_QUEUE_TIMEOUT_MS', 120000), executionMs: number('CHAT_EXECUTION_TIMEOUT_MS', 600000),
  };
}

type Job = { owner: string; session: string; task: (signal: AbortSignal) => Promise<void>;
  resolve: () => void; reject: (error: unknown) => void; controller: AbortController;
  timer?: ReturnType<typeof setTimeout> };

export class ChatScheduler {
  private queue: Job[] = [];
  private active = new Set<Job>();
  private arrivals = new Map<string, number[]>();
  private lastOwner: string | undefined;
  constructor(readonly limits = chatLimits()) {}
  busy(session: string) { return [...this.active, ...this.queue].some(job => job.session === session); }

  submit(owner: string, session: string, task: Job['task']) {
    const now = Date.now();
    for (const [user, values] of this.arrivals) {
      const recent = values.filter(value => value > now - 60000);
      if (recent.length) this.arrivals.set(user, recent); else this.arrivals.delete(user);
    }
    const recent = this.arrivals.get(owner) ?? [];
    if (recent.length >= this.limits.perMinute) throw new ChatError(429, 'user_rate_limited', '提交过于频繁，请稍后重试');
    const runnable = this.active.size < this.limits.concurrency && !this.busy(session) &&
      [...this.active].filter(job => job.owner === owner).length < this.limits.userConcurrency;
    if (!runnable && this.queue.filter(job => job.owner === owner).length >= this.limits.userQueue)
      throw new ChatError(429, 'user_queue_full', '用户等待队列已满，请稍后重试');
    if (!runnable && this.queue.length >= this.limits.queue)
      throw new ChatError(503, 'queue_full', '服务等待队列已满，请稍后重试');
    this.arrivals.set(owner, [...recent, now]);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = { owner, session, task, resolve, reject, controller: new AbortController() };
    const cancel = () => {
      job.controller.abort(new ChatError(409, 'cancelled', '已请求取消；已完成的 OA 操作不会回滚'));
      if (this.queue.includes(job)) {
        this.queue = this.queue.filter(value => value !== job);
        clearTimeout(job.timer); reject(job.controller.signal.reason); this.pump();
      }
    };
    job.timer = setTimeout(() => {
      this.queue = this.queue.filter(value => value !== job);
      reject(new ChatError(409, 'queue_timeout', '排队超时，未执行 Agent')); this.pump();
    }, this.limits.queueMs);
    this.queue.push(job);
    // Reserve capacity synchronously; execute task in a microtask after registration.
    this.pump();
    return { done, cancel };
  }
  private pump() {
    while (this.active.size < this.limits.concurrency) {
      const eligible = this.queue.filter(job => ![...this.active].some(active => active.session === job.session) &&
        [...this.active].filter(active => active.owner === job.owner).length < this.limits.userConcurrency);
      const job = eligible.find(value => value.owner !== this.lastOwner) ?? eligible[0];
      if (!job) return;
      this.queue = this.queue.filter(value => value !== job);
      clearTimeout(job.timer); this.active.add(job); this.lastOwner = job.owner;
      job.timer = setTimeout(() => job.controller.abort(new ChatError(409, 'execution_timeout', '执行超时，正在停止；业务结果可能需要核对')), this.limits.executionMs);
      void Promise.resolve().then(() => job.task(job.controller.signal)).then(job.resolve, job.reject).finally(() => {
        clearTimeout(job.timer); this.active.delete(job); this.pump();
      });
    }
  }
}
