import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProjectProgressBaseline } from "../src/benchmark/projectProgressBaseline.js";

describe("project progress concurrency baseline", () => {
  it("repeats the P=100, R=50, A=20 fake-server scenario", async () => {
    const baseline = await runProjectProgressBaseline();

    assert.deepEqual(baseline.scenario, {
      projects: 100,
      repositories: 50,
      agentTasks: 20,
    });
    assert.equal(baseline.report.projects.length, 100);
    assert.equal(baseline.report.metrics.repositoriesDiscovered, 50);
    assert.equal(baseline.report.metrics.repositoriesWithCommits, 20);
    assert.equal(baseline.report.metrics.repositoryTasksTotal, 20);
    assert.equal(baseline.report.metrics.githubPeakConcurrency, 6);
    assert.equal(baseline.report.metrics.agentPeakConcurrency, 2);
    assert.deepEqual(baseline.requestCounts, {
      "github.branches.list": 50,
      "github.commits.list": 50,
      "github.repository.get": 50,
      "model.project-progress.summarize": 20,
      "oa.project.list": 1,
    });
    assert.equal(baseline.agentQueueWait.count, 20);
    assert.ok(baseline.durationMs >= 0);
    assert.ok(baseline.memory.rssPeakBytes >= baseline.memory.rssStartBytes);
  });
});
