import type {
  AutomationAiInteraction,
  AutomationRun,
} from "./automation-api"

const ACTIVE_AUTOMATION_RUN_STATUSES = new Set<AutomationRun["status"]>([
  "pending",
  "claimed",
  "running",
])

export function isActiveAutomationRun(run: AutomationRun): boolean {
  return ACTIVE_AUTOMATION_RUN_STATUSES.has(run.status)
}

export function hasActiveAutomationRuns(runs: AutomationRun[]): boolean {
  return runs.some(isActiveAutomationRun)
}

export function hasPollableAutomationRuns(
  runs: AutomationRun[],
  now = Date.now(),
): boolean {
  return runs.some((run) => {
    const deadline = Date.parse(run.deadline_at)
    return isActiveAutomationRun(run) &&
      Number.isFinite(deadline) &&
      deadline > now
  })
}

export function shouldRefreshAutomationRunDetail(
  run: AutomationRun,
  previousRun?: AutomationRun,
): boolean {
  return !previousRun || run.status !== previousRun.status
}

export function resolveAutomationRunReply(
  run: AutomationRun,
  interaction?: AutomationAiInteraction,
): string {
  if (interaction?.final_summary?.trim()) {
    return interaction.final_summary.trim()
  }
  if (interaction?.error_summary?.trim()) {
    return `${interaction.error_code ? `${interaction.error_code}：` : ""}${interaction.error_summary.trim()}`
  }
  if (
    interaction?.response_payload_sanitized !== null &&
    interaction?.response_payload_sanitized !== undefined
  ) {
    return formatAutomationPayload(interaction.response_payload_sanitized)
  }
  if (run.error_summary?.trim()) {
    return `${run.error_code ? `${run.error_code}：` : ""}${run.error_summary.trim()}`
  }
  if (ACTIVE_AUTOMATION_RUN_STATUSES.has(run.status)) {
    return "任务正在处理中，AI 回复尚未生成。"
  }
  if (run.status === "succeeded" && (run.ai_interaction_count ?? 0) === 0) {
    const commitCount = run.projects?.reduce(
      (total, project) => total + project.commit_count,
      0,
    )
    const checkedProjects = run.projects_total > 0
      ? `共检查 ${run.projects_total} 个项目；`
      : ""
    if (commitCount === undefined || commitCount === 0) {
      return `本次运行已成功完成，${checkedProjects}当天没有新增 Commit，因此无需调用 AI 生成总结。`
    }
    return `本次运行已成功完成，${checkedProjects}${commitCount} 条 Commit 已存在相同摘要，因此无需重复调用 AI。`
  }
  return "本次运行已结束，但没有产生可展示的 AI 回复，请查看运行详情。"
}

export function formatAutomationPayload(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}
