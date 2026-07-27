import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ProjectProgressStore } from "../src/infrastructure/persistence/projectProgressStore.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("ProjectProgressStore", () => {
  it("keeps separate consumption watermarks for projects sharing a repository", async () => {
    const store = await createStore();
    store.saveProjectRepositoryWatermark(11, 9001, "2026-07-24T10:00:00.000Z");
    store.saveProjectRepositoryWatermark(12, 9001, "2026-07-24T11:00:00.000Z");

    assert.equal(
      store.getProjectRepositoryWatermark(11, 9001),
      "2026-07-24T10:00:00.000Z",
    );
    assert.equal(
      store.getProjectRepositoryWatermark(12, 9001),
      "2026-07-24T11:00:00.000Z",
    );
    store.close();
  });

  it("recovers pending outbox intents after restart", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "project-progress-store-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "state.sqlite");
    const first = new ProjectProgressStore(databasePath);
    first.enqueueOutbox({
      intentKey: "summary:11:2026-07-24:digest",
      operation: "summary.create",
      projectId: 11,
      payload: { summary: "完成登录优化" },
    });
    first.close();

    const restarted = new ProjectProgressStore(databasePath);
    assert.deepEqual(
      restarted.listPendingOutbox().map((intent) => intent.intentKey),
      ["summary:11:2026-07-24:digest"],
    );
    restarted.close();
  });

  it("persists a daily source digest and generated draft", async () => {
    const store = await createStore();
    store.saveDailySummaryDraft({
      projectId: 11,
      summaryDate: "2026-07-24",
      sourceDigest: "a".repeat(64),
      summary: "完成登录优化。",
      aiConfidence: 90,
      aiNote: "基于 1 条提交。",
    });

    assert.deepEqual(store.getDailySummaryDraft(11, "2026-07-24"), {
      sourceDigest: "a".repeat(64),
      summary: "完成登录优化。",
      aiConfidence: 90,
      aiNote: "基于 1 条提交。",
    });
    store.close();
  });

  it("persists managed summary ownership and applied outbox state", async () => {
    const store = await createStore();
    const digest = "b".repeat(64);
    store.saveDailySummaryDraft({
      projectId: 11,
      summaryDate: "2026-07-24",
      sourceDigest: digest,
      summary: "完成测试写入。",
      aiConfidence: 90,
      aiNote: "测试库。",
    });
    store.enqueueOutbox({
      intentKey: "test:summary:create:11",
      operation: "summary.create",
      projectId: 11,
      payload: { summary: "完成测试写入。" },
    });
    store.markSummaryApplied({
      projectId: 11,
      summaryDate: "2026-07-24",
      summaryId: 301,
      sourceDigest: digest,
      summary: "完成测试写入。",
      aiConfidence: 90,
      aiNote: "测试库。",
    });
    store.markOutboxApplied("test:summary:create:11");

    assert.deepEqual(store.getManagedSummary(11, "2026-07-24"), {
      summaryId: 301,
      sourceDigest: digest,
      appliedPayload: {
        summary: "完成测试写入。",
        aiConfidence: 90,
        aiNote: "测试库。",
      },
    });
    assert.deepEqual(store.listPendingOutbox(), []);
    store.close();
  });

  it("returns null for unknown state and validates unsafe identifiers", async () => {
    const store = await createStore();
    assert.equal(store.getProjectRepositoryWatermark(1, 1), null);
    assert.equal(store.getDailySummaryDraft(1, "2026-07-24"), null);
    assert.equal(store.getManagedSummary(1, "2026-07-24"), null);
    assert.throws(
      () => store.saveProjectRepositoryWatermark(0, 1, new Date().toISOString()),
      /projectId/,
    );
    assert.throws(
      () => store.saveDailySummaryDraft({
        projectId: 1,
        summaryDate: "2026/07/24",
        sourceDigest: "a".repeat(64),
        summary: "",
        aiConfidence: 90,
        aiNote: "",
      }),
      /YYYY-MM-DD/,
    );
    store.close();
    store.close();
  });
});

async function createStore(): Promise<ProjectProgressStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "project-progress-store-"));
  temporaryDirectories.push(directory);
  return new ProjectProgressStore(path.join(directory, "state.sqlite"));
}
