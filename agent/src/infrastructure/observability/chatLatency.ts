import { performance } from "node:perf_hooks";

export type ChatLatencyStage =
  | "auth"
  | "queue_wait"
  | "session_prepare"
  | "contracts"
  | "semantic_route"
  | "request_routing"
  | "persistence"
  | "codex_startup"
  | "request_ttft"
  | "model_ttft"
  | "model_inference"
  | "model_turn"
  | "stream_drain"
  | "total";

export type ChatLatencyMilestone =
  | "stream_connected"
  | "routing_started"
  | "routing_completed"
  | "codex_invoked"
  | "turn_started"
  | "first_message"
  | "turn_completed"
  | "codex_stream_closed";

export type ChatLatencyStatus = "completed" | "failed" | "aborted";

export type ChatLatencyDistribution = {
  count: number;
  p50: number;
  p95: number;
  max: number;
};

export type ChatLatencyRollingSnapshot = {
  windowSize: number;
  samples: number;
  stages: Partial<Record<ChatLatencyStage, ChatLatencyDistribution>>;
};

export type ChatLatencyToolSummary = {
  count: number;
  totalMs: number;
  byType: Record<string, { count: number; totalMs: number }>;
};

export type ChatLatencyRecord = {
  event: "chat.latency";
  version: 1;
  requestId: string;
  startedAt: string;
  status: ChatLatencyStatus;
  provider?: string;
  model?: string;
  errorCode?: string;
  durationsMs: Partial<Record<ChatLatencyStage, number>>;
  milestonesMs: Partial<Record<ChatLatencyMilestone, number>>;
  tools: ChatLatencyToolSummary;
  rolling: ChatLatencyRollingSnapshot;
};

type ChatLatencyFinishInput = {
  status: ChatLatencyStatus;
  provider?: string;
  model?: string;
  errorCode?: string;
};

type ChatLatencyMetricsRecorderOptions = {
  now?: () => number;
  wallNow?: () => Date;
  windowSize?: number;
  logger?: (record: ChatLatencyRecord) => void;
};

type ActiveTool = {
  type: string;
  startedAt: number;
};

type CompletedTool = {
  type: string;
  durationMs: number;
};

type ActiveStage = {
  stage: ChatLatencyStage;
  startedAt: number;
};

export class ChatLatencyTrace {
  private readonly startedAt: number;
  private readonly startedAtWall: string;
  private readonly durations: Partial<Record<ChatLatencyStage, number>> = {};
  private readonly milestones: Partial<Record<ChatLatencyMilestone, number>> = {};
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activeStages = new Map<number, ActiveStage>();
  private readonly completedTools: CompletedTool[] = [];
  private finishedRecord: ChatLatencyRecord | null = null;
  private nextStageId = 0;

  constructor(
    private readonly recorder: ChatLatencyMetricsRecorder,
    readonly requestId: string,
  ) {
    this.startedAt = recorder.timestamp();
    this.startedAtWall = recorder.wallTimestamp();
  }

  startStage(stage: ChatLatencyStage): () => void {
    const startedAt = this.recorder.timestamp();
    const stageId = this.nextStageId;
    this.nextStageId += 1;
    this.activeStages.set(stageId, { stage, startedAt });
    let finished = false;
    return () => {
      if (finished || this.finishedRecord) {
        return;
      }
      finished = true;
      this.activeStages.delete(stageId);
      this.addDuration(stage, this.recorder.timestamp() - startedAt);
    };
  }

  mark(milestone: ChatLatencyMilestone): void {
    if (this.finishedRecord) {
      return;
    }
    this.milestones[milestone] = this.elapsed();
  }

  markOnce(milestone: ChatLatencyMilestone): void {
    if (this.milestones[milestone] === undefined) {
      this.mark(milestone);
    }
  }

  toolStarted(itemId: string, type: string): void {
    if (this.finishedRecord || this.activeTools.has(itemId)) {
      return;
    }
    this.activeTools.set(itemId, {
      type,
      startedAt: this.recorder.timestamp(),
    });
  }

  toolCompleted(itemId: string): void {
    const active = this.activeTools.get(itemId);
    if (!active || this.finishedRecord) {
      return;
    }
    this.activeTools.delete(itemId);
    this.completedTools.push({
      type: active.type,
      durationMs: roundMilliseconds(
        this.recorder.timestamp() - active.startedAt,
      ),
    });
  }

  finish(input: ChatLatencyFinishInput): ChatLatencyRecord {
    if (this.finishedRecord) {
      return this.finishedRecord;
    }

    const finishedAt = this.recorder.timestamp();
    for (const [stageId, active] of this.activeStages) {
      this.addDuration(active.stage, finishedAt - active.startedAt);
      this.activeStages.delete(stageId);
    }
    for (const [itemId, active] of this.activeTools) {
      this.completedTools.push({
        type: active.type,
        durationMs: roundMilliseconds(finishedAt - active.startedAt),
      });
      this.activeTools.delete(itemId);
    }

    this.durations.total = roundMilliseconds(finishedAt - this.startedAt);
    this.addDerivedDurations();
    this.finishedRecord = this.recorder.record({
      event: "chat.latency",
      version: 1,
      requestId: this.requestId,
      startedAt: this.startedAtWall,
      status: input.status,
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      durationsMs: { ...this.durations },
      milestonesMs: { ...this.milestones },
      tools: summarizeTools(this.completedTools),
    });
    return this.finishedRecord;
  }

  private elapsed(): number {
    return roundMilliseconds(this.recorder.timestamp() - this.startedAt);
  }

  private addDuration(stage: ChatLatencyStage, durationMs: number): void {
    this.durations[stage] = roundMilliseconds(
      (this.durations[stage] ?? 0) + Math.max(0, durationMs),
    );
  }

  private addDerivedDurations(): void {
    this.deriveDuration("codex_startup", "codex_invoked", "turn_started");
    this.deriveDuration("request_ttft", null, "first_message");
    this.deriveDuration("model_ttft", "codex_invoked", "first_message");
    this.deriveDuration("model_inference", "turn_started", "first_message");
    this.deriveDuration("model_turn", "turn_started", "turn_completed");
    this.deriveDuration("stream_drain", "turn_completed", "codex_stream_closed");
  }

  private deriveDuration(
    stage: ChatLatencyStage,
    start: ChatLatencyMilestone | null,
    end: ChatLatencyMilestone,
  ): void {
    const startMs = start ? this.milestones[start] : 0;
    const endMs = this.milestones[end];
    if (startMs === undefined || endMs === undefined || endMs < startMs) {
      return;
    }
    this.durations[stage] = roundMilliseconds(endMs - startMs);
  }
}

export class ChatLatencyMetricsRecorder {
  private readonly now: () => number;
  private readonly wallNow: () => Date;
  private readonly windowSize: number;
  private readonly logger: (record: ChatLatencyRecord) => void;
  private readonly samples: Array<
    Partial<Record<ChatLatencyStage, number>>
  > = [];

  constructor(options: ChatLatencyMetricsRecorderOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? (() => new Date());
    this.windowSize = Math.max(1, Math.trunc(options.windowSize ?? 100));
    this.logger = options.logger ?? ((record) => {
      console.error(`[chat-latency] ${JSON.stringify(record)}`);
    });
  }

  start(input: { requestId: string }): ChatLatencyTrace {
    return new ChatLatencyTrace(this, input.requestId);
  }

  snapshot(): ChatLatencyRollingSnapshot {
    const valuesByStage = new Map<ChatLatencyStage, number[]>();
    for (const sample of this.samples) {
      for (const [stage, value] of Object.entries(sample)) {
        if (typeof value !== "number") {
          continue;
        }
        const typedStage = stage as ChatLatencyStage;
        const values = valuesByStage.get(typedStage) ?? [];
        values.push(value);
        valuesByStage.set(typedStage, values);
      }
    }
    return {
      windowSize: this.windowSize,
      samples: this.samples.length,
      stages: Object.fromEntries(
        [...valuesByStage.entries()].map(([stage, values]) => [
          stage,
          distribution(values),
        ]),
      ),
    };
  }

  timestamp(): number {
    return this.now();
  }

  wallTimestamp(): string {
    return this.wallNow().toISOString();
  }

  record(
    record: Omit<ChatLatencyRecord, "rolling">,
  ): ChatLatencyRecord {
    this.samples.push({ ...record.durationsMs });
    if (this.samples.length > this.windowSize) {
      this.samples.splice(0, this.samples.length - this.windowSize);
    }
    const completed = { ...record, rolling: this.snapshot() };
    this.logger(completed);
    return completed;
  }
}

export const chatLatencyMetrics = new ChatLatencyMetricsRecorder();

function summarizeTools(tools: CompletedTool[]): ChatLatencyToolSummary {
  const byType: ChatLatencyToolSummary["byType"] = {};
  let totalMs = 0;
  for (const tool of tools) {
    totalMs += tool.durationMs;
    const current = byType[tool.type] ?? { count: 0, totalMs: 0 };
    current.count += 1;
    current.totalMs = roundMilliseconds(current.totalMs + tool.durationMs);
    byType[tool.type] = current;
  }
  return {
    count: tools.length,
    totalMs: roundMilliseconds(totalMs),
    byType,
  };
}

function distribution(values: number[]): ChatLatencyDistribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  };
}

function percentile(sorted: number[], quantile: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? 0;
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}
