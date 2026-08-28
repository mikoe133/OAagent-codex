import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OaRequestQueueFullError,
  OaRequestScheduler,
} from "../src/infrastructure/oa/oaRequestScheduler.js";

describe("OaRequestScheduler", () => {
  it("atomically enforces total, lane, and P0/P1 mutation-group caps", async () => {
    const scheduler = new OaRequestScheduler();
    const p1Gate = deferred<void>();
    const p0Gate = deferred<void>();
    const p2Gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const order: string[] = [];

    const p1 = scheduler.run("p1", async () => {
      order.push("p1:start");
      await p1Gate.promise;
      order.push("p1:end");
    });
    await waitUntil(() => scheduler.metrics.activeByLane.p1 === 1);
    const p0 = scheduler.run("p0", async () => {
      order.push("p0:start");
      await p0Gate.promise;
    });
    const p2 = p2Gates.map((gate, index) => scheduler.run("p2", async () => {
      order.push(`p2-${index}:start`);
      await gate.promise;
    }));
    await waitUntil(() => scheduler.metrics.activeTotal === 4);

    assert.deepEqual(scheduler.metrics.activeByLane, {
      p0: 0,
      p1: 1,
      p2: 3,
      p3: 0,
    });
    assert.equal(scheduler.metrics.pendingByLane.p0, 1);
    assert.equal(order.includes("p0:start"), false);

    p1Gate.resolve();
    await waitUntil(() => order.includes("p0:start"));
    assert.equal(scheduler.metrics.activeByLane.p0, 1);
    assert.equal(scheduler.metrics.activeByLane.p1, 0);

    p0Gate.resolve();
    p2Gates.forEach((gate) => gate.resolve());
    await Promise.all([p1, p0, ...p2]);
    assert.equal(scheduler.metrics.peakActiveTotal, 4);
  });

  it("keeps a reserved P0 mailbox when the data queue is full", async () => {
    const scheduler = new OaRequestScheduler({
      totalConcurrency: 1,
      dataQueueCapacity: 2,
    });
    const activeGate = deferred<void>();
    const dataGates = [deferred<void>(), deferred<void>()];
    const p0Gate = deferred<void>();
    const order: string[] = [];
    const active = scheduler.run("p2", async () => {
      order.push("active");
      await activeGate.promise;
    });
    await waitUntil(() => scheduler.metrics.activeTotal === 1);
    const data = dataGates.map((gate, index) => scheduler.run("p2", async () => {
      order.push(`data-${index}`);
      await gate.promise;
    }));
    await waitUntil(() => scheduler.metrics.pendingTotal === 2);
    const p0 = scheduler.run("p0", async () => {
      order.push("p0");
      await p0Gate.promise;
    });

    assert.equal(scheduler.metrics.pendingByLane.p0, 1);
    await assert.rejects(
      scheduler.run("p0", async () => undefined),
      OaRequestQueueFullError,
    );
    await assert.rejects(
      scheduler.run("p3", async () => undefined),
      OaRequestQueueFullError,
    );

    activeGate.resolve();
    await waitUntil(() => order.includes("p0"));
    assert.deepEqual(order.slice(0, 2), ["active", "p0"]);
    p0Gate.resolve();
    await waitUntil(() => order.includes("data-0"));
    dataGates[0]!.resolve();
    await waitUntil(() => order.includes("data-1"));
    dataGates[1]!.resolve();
    await Promise.all([active, p0, ...data]);
  });

  it("removes an aborted waiter without starting its operation", async () => {
    const scheduler = new OaRequestScheduler({ totalConcurrency: 1 });
    const activeGate = deferred<void>();
    const active = scheduler.run("p2", () => activeGate.promise);
    await waitUntil(() => scheduler.metrics.activeTotal === 1);
    const controller = new AbortController();
    let started = false;
    const pending = scheduler.run("p2", async () => {
      started = true;
    }, { signal: controller.signal });
    await waitUntil(() => scheduler.metrics.pendingTotal === 1);

    controller.abort(new Error("cancelled"));
    await assert.rejects(pending, /cancelled/);
    assert.equal(scheduler.metrics.pendingTotal, 0);
    assert.equal(started, false);

    activeGate.resolve();
    await active;
  });

  it("promotes an aged read ahead of a newer business write", async () => {
    let now = 0;
    const scheduler = new OaRequestScheduler({
      totalConcurrency: 1,
      fairnessMaxWaitMs: 50,
      now: () => now,
    });
    const activeGate = deferred<void>();
    const order: string[] = [];
    const active = scheduler.run("p2", () => activeGate.promise);
    await waitUntil(() => scheduler.metrics.activeTotal === 1);
    const agedRead = scheduler.run("p2", async () => {
      order.push("read");
    });
    now = 60;
    const newerWrite = scheduler.run("p1", async () => {
      order.push("write");
    });

    activeGate.resolve();
    await Promise.all([active, agedRead, newerWrite]);
    assert.deepEqual(order, ["read", "write"]);
  });

  it("allows configured business writes to run concurrently", async () => {
    const scheduler = new OaRequestScheduler({
      totalConcurrency: 2,
      laneConcurrency: { p1: 2 },
    });
    const gate = deferred<void>();
    const writes = [0, 1].map(() => scheduler.run("p1", () => gate.promise));

    await waitUntil(() => scheduler.metrics.activeByLane.p1 === 2);
    assert.equal(scheduler.metrics.peakActiveTotal, 2);
    gate.resolve();
    await Promise.all(writes);
  });
});

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
      throw new Error("timed out waiting for scheduler state");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
