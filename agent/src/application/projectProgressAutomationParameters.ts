import {
  decodeAutomationModelParameters,
  type AutomationModelParameters,
} from "../config/modelCatalog.js";
import {
  PROJECT_PROGRESS_SUMMARY_SCOPES,
  type ProjectProgressSummaryScope,
} from "../domain/projectProgress.js";

export function splitProjectProgressAutomationParameters(
  parameters: Record<string, unknown>,
): {
  summaryScope: ProjectProgressSummaryScope;
  modelParameters: AutomationModelParameters;
} {
  const { summary_scope: summaryScopeValue, ...modelParameterValues } = parameters;
  const summaryScope = summaryScopeValue ?? "today";
  if (
    typeof summaryScope !== "string" ||
    !PROJECT_PROGRESS_SUMMARY_SCOPES.some((value) => value === summaryScope)
  ) {
    throw new Error(`不支持的自动任务总结范围:${String(summaryScope)}。`);
  }
  return {
    summaryScope: summaryScope as ProjectProgressSummaryScope,
    modelParameters: decodeAutomationModelParameters(modelParameterValues),
  };
}

export function resolveProjectProgressAutomationParameters(
  modelParameters: Record<string, unknown>,
  executionParameters: {
    projectId?: number;
    summaryScope?: ProjectProgressSummaryScope;
  },
): {
  projectId?: number;
  summaryScope: ProjectProgressSummaryScope;
  modelParameters: AutomationModelParameters;
} {
  const split = splitProjectProgressAutomationParameters(modelParameters);
  return {
    ...(executionParameters.projectId === undefined
      ? {}
      : { projectId: executionParameters.projectId }),
    summaryScope: executionParameters.summaryScope ?? split.summaryScope,
    modelParameters: split.modelParameters,
  };
}
