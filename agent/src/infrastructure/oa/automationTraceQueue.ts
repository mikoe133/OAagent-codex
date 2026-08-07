import type { AutomationTraceEventInput } from "./automationOaClient.js";
import type { AutomationTraceSpoolEntry } from "../persistence/projectProgressStore.js";

const DEFAULT_TRACE_QUEUE_CAPACITY = 100;

export interface AutomationTraceSpool {
  upsertAutomationTraceSpool(entry: AutomationTraceSpoolEntry): boolean;
  listAutomationTraceSpool(runId: string): AutomationTraceSpoolEntry[];
  deleteAutomationTraceSpool(runId: string, eventKey: string): void;
}

export type AutomationTraceQueueMetrics = {
  pending: number;
  inFlight: number;
  resident: number;
  peakResident: number;
  coalesced: number;
  droppedIntermediate: number;
  deliveryFailures: number;
  finalDeliveryFailures: number;
};

export class AutomationTraceDrainTimeoutError extends Error {
  override name = "AutomationTraceDrainTimeoutError";
}

export class BoundedAutomationTraceQueue {
  private readonly capacity: number;
  private readonly pending = new Map<string, AutomationTraceEventInput>();
  private readonly order: string[] = [];
  private readonly terminalKeys = new Set<string>();
  private readonly drainWaiters = new Set<() => void>();
  private inFlightEvent: AutomationTraceEventInput | null = null;
  private pumpRunning = false;
  private peakResident = 0;
  private coalesced = 0;
  private droppedIntermediate = 0;
  private deliveryFailures = 0;
  private finalDeliveryFailures = 0;
  private fatalError: unknown = null;

  constructor(private readonly input: {
    runId: string;
    deliver: (event: AutomationTraceEventInput, signal?: AbortSignal) => Promise<boolean>;
    spool?: AutomationTraceSpool;
    capacity?: number;
    signal?: AbortSignal;
  }) {
    if (!input.runId.trim()) {
      throw new Error("trace queue runId 不能为空。");
    }
    this.capacity = input.capacity ?? DEFAULT_TRACE_QUEUE_CAPACITY;
    if (!Number.isInteger(this.capacity) || this.capacity < 1) {
      throw new Error("trace queue capacity 必须是正整数。");
    }
    for (const entry of input.spool?.listAutomationTraceSpool(input.runId) ?? []) {
      const event = decodeSpoolEvent(entry);
      this.enqueueRecovered(event);
    }
    this.updatePeakResident();
    this.schedulePump();
  }

  get metrics(): AutomationTraceQueueMetrics {
    const inFlight = this.inFlightEvent ? 1 : 0;
    return {
      pending: this.pending.size,
      inFlight,
      resident: this.pending.size + inFlight,
      peakResident: this.peakResident,
      coalesced: this.coalesced,
      droppedIntermediate: this.droppedIntermediate,
      deliveryFailures: this.deliveryFailures,
      finalDeliveryFailures: this.finalDeliveryFailures,
    };
  }

  tryEnqueue(event: AutomationTraceEventInput): boolean {
    if (this.fatalError !== null) {
      return false;
    }
    const terminal = isTerminalStatus(event.status);
    if (!terminal && this.terminalKeys.has(event.eventKey)) {
      this.droppedIntermediate += 1;
      return false;
    }
    const existing = this.pending.get(event.eventKey);
    if (existing) {
      if (isTerminalStatus(existing.status) && !terminal) {
        this.droppedIntermediate += 1;
        return false;
      }
      this.pending.set(event.eventKey, event);
      if (terminal) {
        this.terminalKeys.add(event.eventKey);
      }
      this.coalesced += 1;
      this.notifyDrainWaiters();
      return true;
    }

    if (this.metrics.resident >= this.capacity) {
      if (!terminal) {
        this.droppedIntermediate += 1;
        return false;
      }
      const victimIndex = this.order.findIndex((eventKey) => {
        const queued = this.pending.get(eventKey);
        return queued !== undefined && !isTerminalStatus(queued.status);
      });
      if (victimIndex < 0) {
        return false;
      }
      const [victimKey] = this.order.splice(victimIndex, 1);
      if (victimKey) {
        this.pending.delete(victimKey);
        this.droppedIntermediate += 1;
      }
    }

    this.pending.set(event.eventKey, event);
    this.order.push(event.eventKey);
    if (terminal) {
      this.terminalKeys.add(event.eventKey);
    }
    this.updatePeakResident();
    this.schedulePump();
    this.notifyDrainWaiters();
    return true;
  }

  async drain(options: {
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 3_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("trace drain timeoutMs 必须是非负有限数。");
    }
    options.signal?.throwIfAborted();
    if (this.fatalError !== null) {
      throw this.fatalError;
    }
    if (this.isIdle()) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        this.drainWaiters.delete(check);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (operation: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        operation();
      };
      const check = () => {
        if (this.fatalError !== null) {
          settle(() => reject(this.fatalError));
        } else if (this.isIdle()) {
          settle(resolve);
        } else {
          this.drainWaiters.add(check);
        }
      };
      const onAbort = () => settle(() => reject(options.signal?.reason));
      const timer = setTimeout(() => settle(() => reject(
        new AutomationTraceDrainTimeoutError(
          `automation trace drain 超过 ${timeoutMs}ms。`,
        ),
      )), timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }

  private enqueueRecovered(event: AutomationTraceEventInput): void {
    if (this.pending.size >= this.capacity) {
      return;
    }
    this.pending.set(event.eventKey, event);
    this.order.push(event.eventKey);
    if (isTerminalStatus(event.status)) {
      this.terminalKeys.add(event.eventKey);
    }
  }

  private schedulePump(): void {
    if (this.pumpRunning || this.pending.size === 0 || this.fatalError !== null) {
      return;
    }
    this.pumpRunning = true;
    queueMicrotask(() => {
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending.size > 0 && this.fatalError === null) {
        const eventKey = this.order.shift();
        if (!eventKey) {
          break;
        }
        const event = this.pending.get(eventKey);
        if (!event) {
          continue;
        }
        this.pending.delete(eventKey);
        this.inFlightEvent = event;
        this.notifyDrainWaiters();
        const terminal = isTerminalStatus(event.status);
        const persisted = this.input.spool?.upsertAutomationTraceSpool({
          runId: this.input.runId,
          eventKey: event.eventKey,
          payload: event,
          terminal,
        }) ?? true;
        if (!persisted) {
          if (terminal) {
            this.finalDeliveryFailures += 1;
          } else {
            this.droppedIntermediate += 1;
          }
          this.inFlightEvent = null;
          this.notifyDrainWaiters();
          continue;
        }

        const delivered = await this.input.deliver(event, this.input.signal);
        this.input.signal?.throwIfAborted();
        if (delivered) {
          this.input.spool?.deleteAutomationTraceSpool(
            this.input.runId,
            event.eventKey,
          );
        } else {
          this.deliveryFailures += 1;
          if (terminal) {
            this.finalDeliveryFailures += 1;
          }
        }
        this.inFlightEvent = null;
        this.notifyDrainWaiters();
      }
    } catch (error) {
      this.fatalError = error;
      if (this.inFlightEvent && isTerminalStatus(this.inFlightEvent.status)) {
        this.finalDeliveryFailures += 1;
      }
      this.inFlightEvent = null;
    } finally {
      this.pumpRunning = false;
      this.notifyDrainWaiters();
      this.schedulePump();
    }
  }

  private isIdle(): boolean {
    return !this.pumpRunning && this.inFlightEvent === null && this.pending.size === 0;
  }

  private updatePeakResident(): void {
    this.peakResident = Math.max(this.peakResident, this.metrics.resident);
  }

  private notifyDrainWaiters(): void {
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }
}

function isTerminalStatus(status: AutomationTraceEventInput["status"]): boolean {
  return status !== "pending" && status !== "running";
}

function decodeSpoolEvent(entry: AutomationTraceSpoolEntry): AutomationTraceEventInput {
  const event = entry.payload as Partial<AutomationTraceEventInput>;
  if (
    event.eventKey !== entry.eventKey ||
    typeof event.sequence !== "number" ||
    typeof event.phase !== "string" ||
    typeof event.status !== "string" ||
    typeof event.title !== "string"
  ) {
    throw new Error(`automation trace spool payload 无效:${entry.eventKey}`);
  }
  return event as AutomationTraceEventInput;
}
