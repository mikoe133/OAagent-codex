import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  AutomationTraceDrainTimeoutError,
  BoundedAutomationTraceQueue,
  type AutomationTraceSpool,
} from "../src/infrastructure/oa/automationTraceQueue.js";
import type { AutomationTraceEventInput } from "../src/infrastructure/oa/automationOaClient.js";

describe("BoundedAutomationTraceQueue", () => {
  it("coalesces by event key and never downgrades a terminal event", async () => {
    const firstGate = deferred<void>();
    const delivered: AutomationTraceEventInput[] = [];
    const queue = new BoundedAutomationTraceQueue({
      runId: "run-01",
      capacity: 2,
      deliver: async (event) => {
        delivered.push(event);
        if (event.eventKey === "first") {
          await firstGate.promise;
        }
        return true;
      },
    });

    assert.equal(queue.tryEnqueue(event("first", "running", 1)), true);
    await waitUntil(() => queue.metrics.inFlight === 1);
    assert.equal(queue.tryEnqueue(event("coalesced", "running", 2)), true);
    assert.equal(queue.tryEnqueue(event("coalesced", "succeeded", 3)), true);
    assert.equal(queue.tryEnqueue(event("coalesced", "running", 4)), false);

    firstGate.resolve();
    await queue.drain({ timeoutMs: 1_000 });

    assert.deepEqual(delivered.map((item) => [item.eventKey, item.status, item.sequence]), [
      ["first", "running", 1],
      ["coalesced", "succeeded", 3],
    ]);
    assert.equal(queue.metrics.coalesced, 1);
    assert.equal(queue.metrics.droppedIntermediate, 1);
  });

  it("stays bounded and lets terminal events evict queued intermediate events", async () => {
    const firstGate = deferred<void>();
    const delivered: AutomationTraceEventInput[] = [];
    const queue = new BoundedAutomationTraceQueue({
      runId: "run-01",
      capacity: 2,
      deliver: async (traceEvent) => {
        delivered.push(traceEvent);
        if (traceEvent.eventKey === "first") {
          await firstGate.promise;
        }
        return true;
      },
    });
    queue.tryEnqueue(event("first", "running", 1));
    await waitUntil(() => queue.metrics.inFlight === 1);
    queue.tryEnqueue(event("middle", "running", 2));

    assert.equal(queue.tryEnqueue(event("overflow", "running", 3)), false);
    assert.equal(queue.tryEnqueue(event("finalize_run", "succeeded", 900)), true);
    assert.equal(queue.metrics.resident, 2);

    firstGate.resolve();
    await queue.drain({ timeoutMs: 1_000 });
    assert.deepEqual(delivered.map((item) => item.eventKey), ["first", "finalize_run"]);
    assert.equal(queue.metrics.droppedIntermediate, 2);
  });

  it("serializes delivery and recovers retained events from the spool", async () => {
    const spool = new MemoryTraceSpool([
      {
        runId: "run-01",
        eventKey: "recovered",
        payload: event("recovered", "running", 1),
        terminal: false,
      },
    ]);
    let active = 0;
    let peak = 0;
    const delivered: string[] = [];
    const queue = new BoundedAutomationTraceQueue({
      runId: "run-01",
      spool,
      deliver: async (traceEvent) => {
        active += 1;
        peak = Math.max(peak, active);
        delivered.push(traceEvent.eventKey);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return traceEvent.eventKey !== "failed-terminal";
      },
    });
    queue.tryEnqueue(event("second", "running", 2));
    queue.tryEnqueue(event("failed-terminal", "failed", 3));

    await queue.drain({ timeoutMs: 1_000 });

    assert.deepEqual(delivered, ["recovered", "second", "failed-terminal"]);
    assert.equal(peak, 1);
    assert.equal(queue.metrics.finalDeliveryFailures, 1);
    assert.deepEqual(
      spool.listAutomationTraceSpool("run-01").map((item) => item.eventKey),
      ["failed-terminal"],
    );
  });

  it("bounds drain time and supports cancellation", async () => {
    const queue = new BoundedAutomationTraceQueue({
      runId: "run-01",
      deliver: async () => await new Promise<boolean>(() => undefined),
    });
    queue.tryEnqueue(event("blocked", "running", 1));

    await assert.rejects(
      queue.drain({ timeoutMs: 10 }),
      AutomationTraceDrainTimeoutError,
    );

    const controller = new AbortController();
    const cancelled = queue.drain({ timeoutMs: 1_000, signal: controller.signal });
    controller.abort(new Error("finalization cancelled"));
    await assert.rejects(cancelled, /finalization cancelled/);
  });

  it("keeps the process alive until an awaited drain timeout settles", () => {
    const moduleUrl = new URL(
      "../src/infrastructure/oa/automationTraceQueue.ts",
      import.meta.url,
    ).href;
    const script = `
      import {
        AutomationTraceDrainTimeoutError,
        BoundedAutomationTraceQueue,
      } from ${JSON.stringify(moduleUrl)};
      const queue = new BoundedAutomationTraceQueue({
        runId: "liveness",
        deliver: async () => await new Promise(() => undefined),
      });
      queue.tryEnqueue({
        eventKey: "blocked",
        sequence: 1,
        phase: "blocked",
        status: "running",
        title: "blocked",
        message: null,
        progressCurrent: null,
        progressTotal: null,
        projectId: null,
        repositoryFullName: null,
        metadataSanitized: {},
        occurredAt: "2026-08-07T00:00:00.000Z",
      });
      try {
        await queue.drain({ timeoutMs: 20 });
        process.exitCode = 2;
      } catch (error) {
        if (!(error instanceof AutomationTraceDrainTimeoutError)) throw error;
      }
    `;

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" },
    );

    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  it("does not touch the spool after an ignored delivery abort settles late", async () => {
    const deliveryGate = deferred<void>();
    const deliveryController = new AbortController();
    const spool = new MemoryTraceSpool();
    const queue = new BoundedAutomationTraceQueue({
      runId: "run-01",
      spool,
      signal: deliveryController.signal,
      deliver: async () => {
        await deliveryGate.promise;
        return true;
      },
    });
    queue.tryEnqueue(event("late", "succeeded", 1));
    await waitUntil(() => queue.metrics.inFlight === 1);

    deliveryController.abort(new Error("worker store is closing"));
    deliveryGate.resolve();
    await waitUntil(() => queue.metrics.inFlight === 0);

    assert.equal(spool.deleteCalls, 0);
  });
});

class MemoryTraceSpool implements AutomationTraceSpool {
  private readonly entries = new Map<string, ReturnType<AutomationTraceSpool["listAutomationTraceSpool"]>[number]>();
  deleteCalls = 0;

  constructor(entries: ReturnType<AutomationTraceSpool["listAutomationTraceSpool"]> = []) {
    for (const entry of entries) {
      this.entries.set(entry.eventKey, entry);
    }
  }

  upsertAutomationTraceSpool(
    entry: Parameters<AutomationTraceSpool["upsertAutomationTraceSpool"]>[0],
  ): boolean {
    const existing = this.entries.get(entry.eventKey);
    if (existing?.terminal && !entry.terminal) {
      return true;
    }
    this.entries.set(entry.eventKey, entry);
    return true;
  }

  listAutomationTraceSpool(runId: string) {
    return [...this.entries.values()].filter((entry) => entry.runId === runId);
  }

  deleteAutomationTraceSpool(_runId: string, eventKey: string): void {
    this.deleteCalls += 1;
    this.entries.delete(eventKey);
  }
}

function event(
  eventKey: string,
  status: AutomationTraceEventInput["status"],
  sequence: number,
): AutomationTraceEventInput {
  return {
    eventKey,
    sequence,
    phase: eventKey,
    status,
    title: eventKey,
    message: null,
    progressCurrent: null,
    progressTotal: null,
    projectId: null,
    repositoryFullName: null,
    metadataSanitized: {},
    occurredAt: "2026-08-07T00:00:00.000Z",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
