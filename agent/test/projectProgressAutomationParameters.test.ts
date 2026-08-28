import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveProjectProgressAutomationParameters,
  splitProjectProgressAutomationParameters,
  splitWeeklyReportAutomationModelParameters,
} from "../src/application/projectProgressAutomationParameters.js";

test("separates summary scope from parameters passed to the model", () => {
  assert.deepEqual(
    splitProjectProgressAutomationParameters({
      summary_scope: "latest_commit_of_updating_projects",
      reasoning_effort: "high",
      max_output_tokens: 2048,
    }),
    {
      summaryScope: "latest_commit_of_updating_projects",
      modelParameters: {
        reasoning_effort: "high",
        max_output_tokens: 2048,
      },
    },
  );
});

test("defaults legacy empty parameters to today's commits", () => {
  assert.deepEqual(splitProjectProgressAutomationParameters({}), {
    summaryScope: "today",
    modelParameters: {},
  });
});

test("uses the run snapshot to target one project without passing it to the model", () => {
  assert.deepEqual(
    resolveProjectProgressAutomationParameters(
      {
        summary_scope: "latest_commit_of_updating_projects",
        reasoning_effort: "high",
      },
      { projectId: 51, summaryScope: "today" },
    ),
    {
      projectId: 51,
      summaryScope: "today",
      modelParameters: { reasoning_effort: "high" },
    },
  );
});

test("separates weekly report business parameters from model parameters", () => {
  assert.deepEqual(
    splitWeeklyReportAutomationModelParameters({
      project_scope: "all_projects",
      include_archived_projects: true,
      write_archived_projects: true,
      minimum_confidence: 0.8,
      on_ambiguous: "no_write",
      debounce_seconds: 60,
      reasoning_effort: "high",
      max_output_tokens: 2048,
    }),
    {
      reasoning_effort: "high",
      max_output_tokens: 2048,
    },
  );
});

test("rejects unknown weekly report model parameters", () => {
  assert.throws(
    () => splitWeeklyReportAutomationModelParameters({
      project_scope: "all_projects",
      unsupported_parameter: true,
    }),
    /model_parameters 包含不支持的字段:unsupported_parameter/,
  );
});
