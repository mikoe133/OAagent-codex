import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChatLatencyMetricsRecorder,
  type ChatLatencyRecord,
} from "../src/infrastructure/observability/chatLatency.js";

describe("ChatLatencyMetricsRecorder", () => {
  it("records request stages, model milestones, tools, and safe metadata", () => {
    let now = 1_000;
    const records: ChatLatencyRecord[] = [];
    const recorder = new ChatLatencyMetricsRecorder({
      now: () => now,
      wallNow: () => new Date("2026-08-25T08:00:00.000Z"),
      logger: (record) => records.push(record),
    });
    const trace = recorder.start({ requestId: "request-1" });

    const finishAuth = trace.startStage("auth");
    now = 1_012;
    finishAuth();
    finishAuth();

    trace.mark("codex_invoked");
    now = 1_017;
    trace.mark("turn_started");
    now = 1_029;
    trace.markOnce("first_message");
    now = 1_031;
    trace.markOnce("first_message");

    trace.toolStarted("tool-1", "command_execution");
    now = 1_041;
    trace.toolCompleted("tool-1");
    now = 1_047;
    trace.mark("turn_completed");
    now = 1_053;
    trace.mark("codex_stream_closed");
    now = 1_060;

    const record = trace.finish({
      status: "completed",
      provider: "nexttoken",
      model: "gpt-5.6-terra",
    });

    assert.deepEqual(record, records[0]);
    assert.equal(record.event, "chat.latency");
    assert.equal(record.version, 1);
    assert.equal(record.startedAt, "2026-08-25T08:00:00.000Z");
    assert.equal(record.status, "completed");
    assert.equal(record.provider, "nexttoken");
    assert.equal(record.model, "gpt-5.6-terra");
    assert.equal(record.durationsMs.auth, 12);
    assert.equal(record.durationsMs.total, 60);
    assert.equal(record.durationsMs.codex_startup, 5);
    assert.equal(record.durationsMs.request_ttft, 29);
    assert.equal(record.durationsMs.model_ttft, 17);
    assert.equal(record.durationsMs.model_inference, 12);
    assert.equal(record.durationsMs.model_turn, 30);
    assert.equal(record.durationsMs.stream_drain, 6);
    assert.deepEqual(record.tools, {
      count: 1,
      totalMs: 10,
      byType: {
        command_execution: { count: 1, totalMs: 10 },
      },
    });
    assert.deepEqual(record.rolling.stages.total, {
      count: 1,
      p50: 60,
      p95: 60,
      max: 60,
    });
    assert.doesNotMatch(
      JSON.stringify(record),
      /"(?:sessionId|token|prompt|message)"/i,
    );

    assert.equal(trace.finish({ status: "failed" }), record);
    assert.equal(records.length, 1);
  });

  it("keeps rolling p50 and p95 distributions within the configured window", () => {
    let now = 0;
    const recorder = new ChatLatencyMetricsRecorder({
      now: () => now,
      wallNow: () => new Date(0),
      windowSize: 3,
      logger: () => undefined,
    });

    for (const totalMs of [10, 20, 30, 100]) {
      const trace = recorder.start({ requestId: `request-${totalMs}` });
      now += totalMs;
      trace.finish({ status: "completed" });
    }

    assert.deepEqual(recorder.snapshot(), {
      windowSize: 3,
      samples: 3,
      stages: {
        total: {
          count: 3,
          p50: 30,
          p95: 100,
          max: 100,
        },
      },
    });
  });

  it("accumulates repeated stages and closes unfinished tools on failure", () => {
    let now = 0;
    const recorder = new ChatLatencyMetricsRecorder({
      now: () => now,
      wallNow: () => new Date(0),
      logger: () => undefined,
    });
    const trace = recorder.start({ requestId: "failed-request" });

    const finishFirstPersist = trace.startStage("persistence");
    now = 4;
    finishFirstPersist();
    const finishSecondPersist = trace.startStage("persistence");
    now = 10;
    finishSecondPersist();
    trace.toolStarted("tool-1", "mcp_tool_call");
    trace.startStage("semantic_route");
    now = 16;

    const record = trace.finish({ status: "failed", errorCode: "agent_failed" });

    assert.equal(record.durationsMs.persistence, 10);
    assert.equal(record.durationsMs.semantic_route, 6);
    assert.equal(record.errorCode, "agent_failed");
    assert.deepEqual(record.tools, {
      count: 1,
      totalMs: 6,
      byType: {
        mcp_tool_call: { count: 1, totalMs: 6 },
      },
    });
  });
});
