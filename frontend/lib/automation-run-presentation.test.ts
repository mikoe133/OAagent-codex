import assert from "node:assert/strict"
import test from "node:test"

import type { AutomationRun, AutomationRunProject } from "./automation-api"
import {
  buildAutomationProjectOutcomeChartData,
  hasActiveAutomationRuns,
  hasPollableAutomationRuns,
  resolveAutomationRunReply,
  shouldRefreshAutomationRunDetail,
} from "./automation-run-presentation"

test("aggregates project outcome tags and accounts for unloaded project details", () => {
  const data = buildAutomationProjectOutcomeChartData([
    project({ id: 1, outcome: "evaluated", commit_count: 3, generated_summary: "完成" }),
    project({ id: 2, outcome: "evaluated", commit_count: 0, generated_summary: null }),
    project({ id: 3, outcome: "archived" }),
    project({ id: 4, outcome: "archived" }),
    project({ id: 5, outcome: "incomplete" }),
    project({ id: 6, outcome: "future_outcome" }),
  ], 8)

  assert.deepEqual(
    data.map(({ id, label, value }) => ({ id, label, value })),
    [
      { id: "evaluated", label: "完成评估", value: 1 },
      { id: "no_commits", label: "当天无提交", value: 1 },
      { id: "archived", label: "已归档", value: 2 },
      { id: "incomplete", label: "处理不完整", value: 1 },
      { id: "other", label: "其他结果", value: 1 },
      { id: "unloaded", label: "明细未加载", value: 2 },
    ],
  )
})

test("keeps polling while an automation run is active", () => {
  assert.equal(hasActiveAutomationRuns([run({ status: "pending" })]), true)
  assert.equal(hasActiveAutomationRuns([run({ status: "running" })]), true)
  assert.equal(hasActiveAutomationRuns([run({ status: "succeeded" })]), false)
})

test("refreshes only new runs or runs whose status changed", () => {
  const succeeded = run({ status: "succeeded" })

  assert.equal(shouldRefreshAutomationRunDetail(succeeded), true)
  assert.equal(
    shouldRefreshAutomationRunDetail(
      run({ status: "running" }),
      run({ status: "running" }),
    ),
    false,
  )
  assert.equal(
    shouldRefreshAutomationRunDetail(
      run({ status: "running" }),
      run({ status: "pending" }),
    ),
    true,
  )
  assert.equal(
    shouldRefreshAutomationRunDetail(
      succeeded,
      run({ status: "running" }),
    ),
    true,
  )
  assert.equal(shouldRefreshAutomationRunDetail(succeeded, succeeded), false)
})

test("stops polling active runs after their deadline", () => {
  const now = Date.parse("2026-08-03T04:30:00.000Z")

  assert.equal(
    hasPollableAutomationRuns([
      run({ status: "pending", deadline_at: "2026-08-03T04:45:00.000Z" }),
    ], now),
    true,
  )
  assert.equal(
    hasPollableAutomationRuns([
      run({ status: "pending", deadline_at: "2026-08-03T04:15:00.000Z" }),
    ], now),
    false,
  )
})

test("explains successful runs that had no commits instead of claiming AI is pending", () => {
  assert.equal(
    resolveAutomationRunReply(run({
      status: "succeeded",
      projects_total: 52,
      ai_interaction_count: 0,
      projects: [],
    })),
    "本次运行已成功完成，共检查 52 个项目；当天没有新增 Commit，因此无需调用 AI 生成总结。",
  )
})

test("still shows the generated AI summary when one exists", () => {
  assert.equal(
    resolveAutomationRunReply(
      run({ status: "succeeded", ai_interaction_count: 1 }),
      {
        id: 1,
        run_id: "run-1",
        run_project_id: 2,
        interaction_key: "project-2-summary",
        provider: "nexttoken",
        model: "gpt-5.6-terra",
        model_catalog_version: "catalog-v1",
        prompt_version: "v1",
        fallback_used: false,
        upstream_request_id: null,
        input_tokens: 10,
        output_tokens: 5,
        latency_ms: 100,
        status: "succeeded",
        error_code: null,
        error_summary: null,
        purged_at: null,
        created_at: "2026-07-31T12:00:00.000Z",
        final_summary: "完成自动化联调。",
      },
    ),
    "完成自动化联调。",
  )
})

function run(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: "run-1",
    root_run_id: "run-1",
    parent_run_id: null,
    job_id: 1,
    job_key: "github-project-progress",
    job_name: "GitHub 项目进度",
    job_type: "github_project_progress_sync",
    tags: [],
    trigger_source: "manual",
    scheduled_at: "2026-07-31T12:00:00.000Z",
    available_at: "2026-07-31T12:00:00.000Z",
    triggered_at: "2026-07-31T12:00:00.000Z",
    status: "pending",
    attempt: 1,
    model_provider: "nexttoken",
    model_id: "gpt-5.6-terra",
    deadline_at: "2026-07-31T12:45:00.000Z",
    started_at: null,
    finished_at: null,
    projects_total: 0,
    projects_succeeded: 0,
    projects_failed: 0,
    mutations_applied: false,
    retry_recommended: false,
    error_code: null,
    error_summary: null,
    cancel_requested_at: null,
    duration_ms: null,
    ...overrides,
  }
}

function project(overrides: Partial<AutomationRunProject>): AutomationRunProject {
  return {
    id: 1,
    run_id: "run-1",
    project_id: 1,
    project_name: "测试项目",
    status_before: "updating",
    status_after: "updating",
    outcome: "evaluated",
    repository_count: 1,
    commit_count: 1,
    summary_date: "2026-08-04",
    source_digest: "source-digest",
    generated_summary: "项目总结",
    ai_confidence: 90,
    ai_note: null,
    warnings: [],
    mutations_applied: false,
    duration_ms: 100,
    created_at: "2026-08-04T00:00:00.000Z",
    updated_at: "2026-08-04T00:00:00.000Z",
    ...overrides,
  }
}
