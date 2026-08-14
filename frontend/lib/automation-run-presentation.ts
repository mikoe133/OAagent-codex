import type {
  AutomationAiInteraction,
  AutomationRun,
  AutomationRunProject,
} from "./automation-api"

const ACTIVE_AUTOMATION_RUN_STATUSES = new Set<AutomationRun["status"]>([
  "pending",
  "claimed",
  "running",
])

export type AutomationProjectOutcomeChartItem = {
  id: string
  label: string
  color: string
  value: number
}

const PROJECT_OUTCOME_CHART_PRESENTATIONS: Record<string, Omit<AutomationProjectOutcomeChartItem, "value">> = {
  evaluated: { id: "evaluated", label: "完成评估", color: "#16A34A" },
  summarized: { id: "summarized", label: "生成总结", color: "#10B981" },
  status_updated: { id: "status_updated", label: "更新状态", color: "#0D9488" },
  no_commits: { id: "no_commits", label: "当天无提交", color: "#0284C7" },
  archived: { id: "archived", label: "已归档", color: "#71717A" },
  no_github_urls: { id: "no_github_urls", label: "无 GitHub 地址", color: "#CA8A04" },
  invalid_github_urls: { id: "invalid_github_urls", label: "GitHub 地址无效", color: "#DC2626" },
  incomplete: { id: "incomplete", label: "处理不完整", color: "#EA580C" },
  write_conflict: { id: "write_conflict", label: "写入冲突", color: "#D97706" },
  failed: { id: "failed", label: "处理失败", color: "#B91C1C" },
}

const PROJECT_OUTCOME_ORDER = Object.keys(PROJECT_OUTCOME_CHART_PRESENTATIONS)
const OTHER_OUTCOME_PRESENTATION = { id: "other", label: "其他结果", color: "#7C3AED" }
const UNLOADED_OUTCOME_PRESENTATION = { id: "unloaded", label: "明细未加载", color: "#94A3B8" }

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

export function projectOutcomeForDisplay(
  project: Pick<AutomationRunProject, "outcome" | "commit_count" | "generated_summary">,
): string {
  if (
    project.outcome === "evaluated" &&
    project.commit_count === 0 &&
    !project.generated_summary?.trim()
  ) {
    return "no_commits"
  }
  return project.outcome
}

export function automationInteractionRepositoryFullName(
  interaction: Pick<AutomationAiInteraction, "request_payload_sanitized">,
): string {
  const payload = interaction.request_payload_sanitized
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "未记录仓库"
  }
  const repositoryFullName = (payload as Record<string, unknown>).repository_full_name
  return typeof repositoryFullName === "string" && repositoryFullName.trim()
    ? repositoryFullName.trim()
    : "未记录仓库"
}

export function buildAutomationProjectOutcomeChartData(
  projects: AutomationRunProject[],
  projectsTotal: number,
): AutomationProjectOutcomeChartItem[] {
  const counts = new Map<string, number>()

  for (const project of projects) {
    const outcome = projectOutcomeForDisplay(project)
    const key = PROJECT_OUTCOME_CHART_PRESENTATIONS[outcome] ? outcome : "other"
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const data = PROJECT_OUTCOME_ORDER.flatMap((key) => {
    const value = counts.get(key) ?? 0
    return value > 0
      ? [{ ...PROJECT_OUTCOME_CHART_PRESENTATIONS[key]!, value }]
      : []
  })
  const otherCount = counts.get("other") ?? 0
  if (otherCount > 0) {
    data.push({ ...OTHER_OUTCOME_PRESENTATION, value: otherCount })
  }

  const unloadedCount = Math.max(0, projectsTotal - projects.length)
  if (unloadedCount > 0) {
    data.push({ ...UNLOADED_OUTCOME_PRESENTATION, value: unloadedCount })
  }
  return data
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
