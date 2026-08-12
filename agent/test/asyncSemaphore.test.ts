import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AsyncSemaphore } from "../src/infrastructure/concurrency/asyncSemaphore.js";

describe("AsyncSemaphore", () => {
  it("limits active work and records the observed peak", async () => {
    const semaphore = new AsyncSemaphore(2);
    let active = 0;
    let observedPeak = 0;

    await Promise.all(
      Array.from({ length: 6 }, (_, index) => semaphore.run(async () => {
        active += 1;
        observedPeak = Math.max(observedPeak, active);
        await delay(5 + index);
        active -= 1;
      })),
    );

    assert.equal(observedPeak, 2);
    assert.equal(semaphore.metrics.peakActive, 2);
    assert.equal(semaphore.metrics.active, 0);
    assert.equal(semaphore.metrics.pending, 0);
  });

  it("rejects pending work when its abort signal is cancelled", async () => {
    const semaphore = new AsyncSemaphore(1);
    let releaseFirst!: () => void;
    const first = semaphore.run(() => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }));
    const controller = new AbortController();
    let secondStarted = false;
    const second = semaphore.run(async () => {
      secondStarted = true;
    }, controller.signal);

    controller.abort(new Error("cancelled by lease"));
    await assert.rejects(second, /cancelled by lease/);
    assert.equal(secondStarted, false);
    releaseFirst();
    await first;
  });
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
