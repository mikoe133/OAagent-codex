import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OperationMetricsRecorder,
} from "../src/infrastructure/observability/operationMetrics.js";

describe("OperationMetricsRecorder", () => {
  it("aggregates stable endpoint counts, outcomes, latency, and queue wait", async () => {
    const clockValues = [0, 4, 10, 22, 30, 37, 40, 49];
    const recorder = new OperationMetricsRecorder({
      now: () => clockValues.shift() ?? 49,
    });

    await recorder.measure("oa.project.list", async () => "ok");
    await assert.rejects(
      recorder.measure("oa.project.list", async () => {
        throw new Error("unavailable");
      }),
      /unavailable/,
    );
    const finishFirstQueueWait = recorder.startQueueWait(
      "model.project-progress.summarize",
    );
    finishFirstQueueWait();
    finishFirstQueueWait();
    const finishSecondQueueWait = recorder.startQueueWait(
      "model.project-progress.summarize",
    );
    finishSecondQueueWait();

    assert.deepEqual(recorder.snapshot(), [
      {
        endpoint: "model.project-progress.summarize",
        requests: 0,
        successes: 0,
        failures: 0,
        durationMs: null,
        queueWaitMs: {
          count: 2,
          min: 7,
          max: 9,
          average: 8,
          p50: 7,
          p95: 9,
        },
      },
      {
        endpoint: "oa.project.list",
        requests: 2,
        successes: 1,
        failures: 1,
        durationMs: {
          count: 2,
          min: 4,
          max: 12,
          average: 8,
          p50: 4,
          p95: 12,
        },
        queueWaitMs: null,
      },
    ]);
  });

  it("returns immutable snapshots and rejects dynamic endpoint names", async () => {
    const recorder = new OperationMetricsRecorder();
    await recorder.measure("github.repository.get", async () => undefined);
    const first = recorder.snapshot();
    first[0]!.requests = 99;

    assert.equal(recorder.snapshot()[0]?.requests, 1);
    await assert.rejects(
      recorder.measure("github.repository.get:example/repo", async () => undefined),
      /稳定的逻辑名称/,
    );
  });
});
