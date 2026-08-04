"use client"

import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import {
  Activity,
  Ban,
  Bot,
  CheckCircle2,
  Circle,
  CircleCheckBig,
  CircleX,
  Clock3,
  Clock5,
  GitCommitHorizontal,
  Loader2,
  ScanSearch,
  TriangleAlert,
  CircleCheck,
  CircleDashed,
  type LucideIcon,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DonutChart, type DonutChartSegment } from "@/components/ui/donut-chart"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AutomationApiError,
  type AutomationRun,
  type AutomationRunProject,
  type AutomationRunTraceEvent,
  cancelAutomationRun,
} from "@/lib/automation-api"
import {
  buildAutomationProjectOutcomeChartData,
  projectOutcomeForDisplay,
} from "@/lib/automation-run-presentation"
import { cn } from "@/lib/utils"

interface AutomationRunDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  run: AutomationRun | null
  traceEvents?: AutomationRunTraceEvent[]
  traceLoading?: boolean
  traceError?: string | null
  loading?: boolean
  error?: string | null
  auditWarning?: string | null
  onCancelled?: () => void | Promise<void>
}

const ACTIVE_STATUSES = new Set<AutomationRun["status"]>(["pending", "claimed", "running"])

export function AutomationRunDetailDialog({
  open,
  onOpenChange,
  run,
  traceEvents = [],
  traceLoading = false,
  traceError,
  loading = false,
  error,
  auditWarning,
  onCancelled,
}: AutomationRunDetailDialogProps) {
  const [isCancelling, setIsCancelling] = React.useState(false)
  const [cancelError, setCancelError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) {
      setCancelError(null)
    }
  }, [open, run?.id])

  async function handleCancel() {
    if (!run) {
      return
    }
    setIsCancelling(true)
    setCancelError(null)
    try {
      await cancelAutomationRun(run.id)
      await onCancelled?.()
    } catch (cancelFailure) {
      setCancelError(resolveError(cancelFailure))
    } finally {
      setIsCancelling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="automation-run-detail-dialog"
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-4xl"
      >
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>任务运行详情</DialogTitle>
          <DialogDescription>
            {run ? `${run.job_display_name ?? run.job_name} · ${run.id}` : "正在读取 OA 运行审计记录。"}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载运行详情…
          </div>
        ) : error ? (
          <div className="p-6">
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : run ? (
          <div className="space-y-6 p-6">
            {auditWarning ? (
              <Alert>
                <TriangleAlert className="text-amber-600" />
                <AlertDescription>{auditWarning}</AlertDescription>
              </Alert>
            ) : null}
            {cancelError ? (
              <Alert variant="destructive">
                <AlertDescription>{cancelError}</AlertDescription>
              </Alert>
            ) : null}

            <RunTraceSection
              events={traceEvents}
              loading={traceLoading}
              error={traceError}
              active={ACTIVE_STATUSES.has(run.status)}
            />

            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="状态" value={runStatusLabel(run.status)} />
              <Metric label="触发方式" value={triggerLabel(run.trigger_source)} />
              <Metric label="执行模型" value={`${run.model_provider}/${run.model_id}`} />
              <Metric label="耗时" value={formatDuration(run.duration_ms)} />
              <Metric label="计划时间" value={formatDateTime(run.scheduled_at)} />
              <Metric label="开始时间" value={formatDateTime(run.started_at)} />
              <Metric label="结束时间" value={formatDateTime(run.finished_at)} />
              <Metric label="执行次数" value={`第 ${run.attempt} 次`} />
            </section>

            <section className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-medium">项目处理结果</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    共 {run.projects_total} 个，成功 {run.projects_succeeded} 个，失败 {run.projects_failed} 个
                  </p>
                </div>
                <div className="flex gap-2">
                  <Badge variant="outline">写入变更：{run.mutations_applied ? "是" : "否"}</Badge>
                  <Badge variant="outline">AI 调用：{run.ai_interaction_count ?? run.ai_interactions?.length ?? 0}</Badge>
                </div>
              </div>
              {run.projects ? (
                <ProjectOutcomeBreakdown
                  projects={run.projects}
                  projectsTotal={run.projects_total}
                />
              ) : null}
              {run.error_summary ? (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription>
                    {run.error_code ? `${run.error_code}：` : ""}{run.error_summary}
                  </AlertDescription>
                </Alert>
              ) : null}
            </section>

            {run.projects ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <GitCommitHorizontal className="h-4 w-4" />
                  <h3 className="font-medium">项目明细</h3>
                </div>
                {run.projects.length < run.projects_total ? (
                  <Alert>
                    <TriangleAlert className="text-amber-600" />
                    <AlertDescription>
                      当前仅加载 {run.projects.length}/{run.projects_total} 个项目明细。其余项目可能因当前账号缺少
                      <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">automation:audit</code>
                      权限，或 OA 详情接口未返回完整项目结果。
                    </AlertDescription>
                  </Alert>
                ) : null}
                {run.projects.length ? run.projects.map((project) => (
                  <article key={project.id} className="rounded-xl border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="font-medium">{project.project_name}</h4>
                        <p className="mt-1 text-xs text-muted-foreground">
                          项目 #{project.project_id} · {project.repository_count} 个仓库 · {project.commit_count} 条 Commit
                        </p>
                      </div>
                      <ProjectOutcomeTag outcome={projectOutcomeForDisplay(project)} />
                    </div>
                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                      <Detail label="状态变化" value={`${project.status_before ?? "—"} → ${project.status_after ?? "—"}`} />
                      <Detail label="总结日期" value={project.summary_date ?? "—"} />
                      <Detail label="AI 置信度" value={project.ai_confidence === null ? "—" : `${project.ai_confidence}%`} />
                    </div>
                    {project.generated_summary ? (
                      <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm leading-6 whitespace-pre-wrap">
                        {project.generated_summary}
                      </div>
                    ) : null}
                    {project.ai_note ? <p className="mt-2 text-xs text-muted-foreground">AI 备注：{project.ai_note}</p> : null}
                    {project.outcome === "incomplete" && project.warnings.length > 0 ? (
                      <ProjectWarnings warnings={project.warnings} />
                    ) : null}
                  </article>
                )) : <Empty text="本次运行尚无项目处理明细。" />}
              </section>
            ) : null}

            {run.ai_interactions ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4" />
                  <h3 className="font-medium">AI 对话与调用审计</h3>
                </div>
                {run.ai_interactions.length ? run.ai_interactions.map((interaction) => (
                  <details key={interaction.id} className="rounded-xl border p-4">
                    <summary className="cursor-pointer list-none">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">{interaction.provider}/{interaction.model}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {interaction.input_tokens ?? 0} 输入 Token · {interaction.output_tokens ?? 0} 输出 Token · {formatDuration(interaction.latency_ms)}
                          </p>
                        </div>
                        <Badge variant={interaction.status === "failed" ? "destructive" : "secondary"}>
                          {interaction.status}{interaction.fallback_used ? " · fallback" : ""}
                        </Badge>
                      </div>
                    </summary>
                    <div className="mt-4 space-y-4 border-t pt-4">
                      <AuditBlock title="系统提示词" value={interaction.system_prompt_snapshot} />
                      <AuditBlock title="脱敏请求" value={interaction.request_payload_sanitized} />
                      <AuditBlock title="脱敏响应" value={interaction.response_payload_sanitized} />
                      <AuditBlock title="最终总结" value={interaction.final_summary} />
                      {interaction.error_summary ? (
                        <Alert variant="destructive">
                          <AlertDescription>{interaction.error_code ? `${interaction.error_code}：` : ""}{interaction.error_summary}</AlertDescription>
                        </Alert>
                      ) : null}
                    </div>
                  </details>
                )) : <Empty text="本次运行没有 AI 调用记录。" />}
              </section>
            ) : null}

            {run.attempts?.length ? (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <Clock3 className="h-4 w-4" />
                  <h3 className="font-medium">重试链路</h3>
                </div>
                <div className="space-y-2">
                  {run.attempts.map((attempt) => (
                    <div key={attempt.id} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
                      <span>第 {attempt.attempt} 次 · {attempt.trigger_source === "retry" ? "自动重试" : triggerLabel(attempt.trigger_source)}</span>
                      <span className="text-muted-foreground">{runStatusLabel(attempt.status)} · {formatDateTime(attempt.started_at ?? attempt.scheduled_at)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="border-t px-6 py-4">
          {run && ACTIVE_STATUSES.has(run.status) ? (
            <Button type="button" variant="destructive" onClick={handleCancel} disabled={isCancelling}>
              {isCancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
              取消本次运行
            </Button>
          ) : run?.status === "succeeded" ? (
            <span className="flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle2 className="h-4 w-4" />运行已完成
            </span>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RunTraceSection({
  events,
  loading,
  error,
  active,
}: {
  events: AutomationRunTraceEvent[]
  loading: boolean
  error?: string | null
  active: boolean
}) {
  const orderedEvents = [...events].sort((left, right) =>
    left.sequence - right.sequence ||
    Date.parse(left.occurred_at) - Date.parse(right.occurred_at),
  )
  const currentEvent = [...orderedEvents].reverse().find(
    (event) => event.status === "running" || event.status === "pending",
  ) ?? orderedEvents.at(-1)

  return (
    <section data-slot="automation-run-trace" className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          <div>
            <h3 className="font-medium">执行 Trace</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {currentEvent?.title ?? (active ? "等待 Worker 上报当前阶段" : "本次运行没有阶段记录")}
            </p>
          </div>
        </div>
        {active ? (
          <Badge variant="outline" className="gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />实时更新
          </Badge>
        ) : null}
      </div>

      {error ? (
        <Alert className="mt-4 border-amber-200 bg-amber-50/60 theme-dark:border-amber-900 theme-dark:bg-amber-950/20">
          <TriangleAlert className="text-amber-600" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading && orderedEvents.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />正在读取执行阶段…
        </div>
      ) : orderedEvents.length ? (
        <ol className="mt-4 space-y-1">
          {orderedEvents.map((event, index) => (
            <TraceEventItem
              key={event.event_key}
              event={event}
              last={index === orderedEvents.length - 1}
            />
          ))}
        </ol>
      ) : !error ? (
        <p className="mt-4 rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
          {active ? "任务已开始，等待第一条 Trace。" : "本次运行没有可展示的 Trace。"}
        </p>
      ) : null}
    </section>
  )
}

function TraceEventItem({
  event,
  last,
}: {
  event: AutomationRunTraceEvent
  last: boolean
}) {
  const progress = traceProgress(event)
  const status = traceStatusPresentation(event.status)
  const TraceIcon = status.icon
  return (
    <li className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 pb-4 last:pb-0">
      {!last ? <span className="absolute left-[11px] top-6 h-[calc(100%-1rem)] w-px bg-border" /> : null}
      <span className={`relative z-10 mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-background ${status.color}`}>
        <TraceIcon className={event.status === "running" ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium">{event.title}</p>
            <Badge variant="outline" className="h-5 px-1.5 text-[0.625rem]">{status.label}</Badge>
          </div>
          <time className="text-[0.6875rem] text-muted-foreground">
            {formatTraceTime(event.updated_at || event.occurred_at)}
          </time>
        </div>
        {event.message ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{event.message}</p> : null}
        {event.repository_full_name ? (
          <p className="mt-1 truncate font-mono text-[0.6875rem] text-muted-foreground">
            {event.repository_full_name}
          </p>
        ) : null}
        {progress ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-sky-500 transition-[width]" style={{ width: `${progress.percent}%` }} />
            </div>
            <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
              {progress.label}
            </span>
          </div>
        ) : null}
      </div>
    </li>
  )
}

function traceProgress(event: AutomationRunTraceEvent): { percent: number; label: string } | null {
  if (
    event.progress_current === null ||
    event.progress_total === null ||
    event.progress_total <= 0
  ) {
    return null
  }
  return {
    percent: Math.min(100, Math.max(0, event.progress_current / event.progress_total * 100)),
    label: `${event.progress_current}/${event.progress_total}`,
  }
}

function traceStatusPresentation(status: AutomationRunTraceEvent["status"]): {
  label: string
  color: string
  icon: typeof Circle
} {
  if (status === "running") return { label: "进行中", color: "text-sky-600", icon: Circle }
  if (status === "succeeded") return { label: "已完成", color: "text-emerald-600", icon: CircleCheckBig }
  if (status === "fallback") return { label: "已兜底", color: "text-amber-600", icon: TriangleAlert }
  if (status === "failed") return { label: "失败", color: "text-red-600", icon: CircleX }
  if (status === "cancelled") return { label: "已取消", color: "text-stone-500", icon: Ban }
  return { label: "等待中", color: "text-stone-400", icon: Circle }
}

function formatTraceTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date)
}

function ProjectOutcomeBreakdown({
  projects,
  projectsTotal,
}: {
  projects: AutomationRunProject[]
  projectsTotal: number
}) {
  const shouldReduceMotion = useReducedMotion()
  const data = React.useMemo(
    () => buildAutomationProjectOutcomeChartData(projects, projectsTotal),
    [projects, projectsTotal],
  )
  const [activeSegmentId, setActiveSegmentId] = React.useState<string | null>(null)
  const activeSegment = data.find((segment) => segment.id === activeSegmentId) ?? null
  const totalValue = data.reduce((sum, segment) => sum + segment.value, 0)

  React.useEffect(() => {
    if (activeSegmentId && !data.some((segment) => segment.id === activeSegmentId)) {
      setActiveSegmentId(null)
    }
  }, [activeSegmentId, data])

  if (totalValue === 0) {
    return null
  }

  const chartData: DonutChartSegment[] = data.map((segment) => ({ ...segment }))
  const displayValue = activeSegment?.value ?? totalValue
  const displayLabel = activeSegment?.label ?? "全部项目"
  const displayPercentage = displayValue / totalValue * 100

  return (
    <div
      data-slot="automation-project-outcome-breakdown"
      className="mt-5 grid items-center gap-5 border-t pt-5 md:grid-cols-[12rem_minmax(0,1fr)]"
    >
      <div className="flex justify-center">
        <DonutChart
          data={chartData}
          totalValue={totalValue}
          size={176}
          strokeWidth={22}
          animationDuration={0.7}
          animationDelayPerSegment={0.04}
          activeSegmentId={activeSegmentId}
          chartLabel="本次运行项目处理结果分布"
          onSegmentHover={(segment) => setActiveSegmentId(segment?.id ?? null)}
          centerContent={(
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={activeSegment?.id ?? "total"}
                initial={shouldReduceMotion ? false : { opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={shouldReduceMotion ? undefined : { opacity: 0, scale: 0.94 }}
                transition={{ duration: shouldReduceMotion ? 0 : 0.16 }}
                className="flex max-w-28 flex-col items-center text-center"
              >
                <span className="text-3xl font-semibold tabular-nums">{displayValue}</span>
                <span className="mt-1 text-xs leading-4 text-muted-foreground">{displayLabel}</span>
                {activeSegment ? (
                  <span className="mt-0.5 text-xs font-medium tabular-nums text-muted-foreground">
                    {formatChartPercentage(displayPercentage)}
                  </span>
                ) : null}
              </motion.div>
            </AnimatePresence>
          )}
        />
      </div>

      <div className="grid min-w-0 gap-1 sm:grid-cols-2" role="list" aria-label="项目处理结果标签统计">
        {data.map((segment, index) => {
          const isActive = segment.id === activeSegmentId
          const percentage = segment.value / totalValue * 100
          return (
            <motion.button
              key={segment.id}
              type="button"
              role="listitem"
              initial={shouldReduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: shouldReduceMotion ? 0 : 0.24,
                delay: shouldReduceMotion ? 0 : 0.08 + index * 0.035,
              }}
              className={cn(
                "grid min-h-10 grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                isActive ? "bg-muted" : "hover:bg-muted/60",
              )}
              aria-label={`${segment.label}：${segment.value} 个，占 ${formatChartPercentage(percentage)}`}
              aria-pressed={isActive}
              onMouseEnter={() => setActiveSegmentId(segment.id)}
              onMouseLeave={() => setActiveSegmentId(null)}
              onClick={() => setActiveSegmentId((current) => current === segment.id ? null : segment.id)}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ backgroundColor: segment.color }}
                aria-hidden="true"
              />
              <span className="min-w-0 truncate text-xs font-medium">{segment.label}</span>
              <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                <strong className="font-semibold text-foreground">{segment.value} 个</strong>
                <span className="mx-1">·</span>
                <span>{formatChartPercentage(percentage)}</span>
              </span>
            </motion.button>
          )
        })}
      </div>
    </div>
  )
}

function formatChartPercentage(value: number): string {
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value)}%`
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-muted/20 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm font-medium">{value}</p>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return <p><span className="text-muted-foreground">{label}：</span>{value}</p>
}

function Empty({ text }: { text: string }) {
  return <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">{text}</p>
}

function AuditBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return null
  }
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">{title}</p>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 text-xs leading-5">{content}</pre>
    </div>
  )
}

function resolveError(error: unknown): string {
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号缺少 automation:write 权限，无法取消运行。"
  }
  return error instanceof Error ? error.message : "取消运行失败"
}

function ProjectOutcomeTag({ outcome }: { outcome: string }) {
  const presentation = projectOutcomePresentation(outcome)
  const Icon = presentation.icon
  return (
    <div
      className={`inline-flex min-h-[35px] min-w-40 items-center justify-center rounded-xl px-4 ${presentation.backgroundClass}`}
      title={presentation.description}
      aria-label={presentation.description}
    >
      <span className={`flex items-center whitespace-nowrap text-xs font-medium ${presentation.textClass}`}>
        <Icon className="mr-2 h-4 w-4" strokeWidth={3} />
        {presentation.label}
      </span>
    </div>
  )
}

function ProjectWarnings({ warnings }: { warnings: Array<Record<string, unknown>> }) {
  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50/70 p-3 text-sm text-red-700 theme-dark:border-red-900/60 theme-dark:bg-red-950/20 theme-dark:text-red-300">
      <div className="flex items-center gap-2 font-medium">
        <TriangleAlert className="h-4 w-4" />
        处理警告
      </div>
      <ul className="mt-2 space-y-1.5 pl-6 text-xs leading-5">
        {warnings.map((warning, index) => (
          <li key={`${warning.code ?? "warning"}-${index}`}>
            {formatProjectWarning(warning)}
          </li>
        ))}
      </ul>
    </div>
  )
}

function formatProjectWarning(warning: Record<string, unknown>): string {
  const code = typeof warning.code === "string" ? warning.code : ""
  if (!code) {
    return JSON.stringify(warning)
  }
  const separatorIndex = code.indexOf(":")
  const prefix = separatorIndex >= 0 ? code.slice(0, separatorIndex) : code
  const detail = separatorIndex >= 0 ? code.slice(separatorIndex + 1) : ""
  const labels: Record<string, string> = {
    project_detail_failed: "读取 OA 项目详情失败",
    repository_read_failed: "读取 GitHub 仓库失败",
    repository_configuration_error: "GitHub 仓库配置错误",
    repository_summary_incomplete: "仓库 Commit 总结不完整",
    repository_summary_failed: "仓库 Commit 总结失败",
    write_failed: "写入项目结果失败",
    status_write_failed: "写入项目状态失败",
    summary_write_failed: "写入项目总结失败",
    cancel_requested: "任务收到取消请求",
  }
  return detail ? `${labels[prefix] ?? "处理警告"}：${detail}` : labels[prefix] ?? code
}

function projectOutcomePresentation(outcome: string): {
  label: string
  description: string
  icon: LucideIcon
  backgroundClass: string
  textClass: string
} {
  const presentations: Record<string, {
    label: string
    description: string
    icon: LucideIcon
    backgroundClass: string
    textClass: string
  }> = {
    evaluated: {
      label: "已完成评估并生成结果",
      description: "已完成评估并生成结果",
      icon: CircleCheck,
      backgroundClass: "bg-emerald-50",
      textClass: "text-[#57BC6C]",
    },
    archived: {
      label: "项目已归档，已跳过处理",
      description: "项目已归档，已跳过处理",
      icon: Clock5,
      backgroundClass: "bg-zinc-100",
      textClass: "text-[#777777]",
    },
    no_github_urls: {
      label: "无 GitHub 地址，已跳过处理",
      description: "无 GitHub 地址，已跳过处理",
      icon: ScanSearch,
      backgroundClass: "bg-yellow-50",
      textClass: "text-[#F0B13D]",
    },
    invalid_github_urls: {
      label: "GitHub 地址无效，处理失败",
      description: "GitHub 地址无效，处理失败",
      icon: CircleX,
      backgroundClass: "bg-red-50",
      textClass: "text-red-600",
    },
    incomplete: {
      label: "处理不完整，未写入结果",
      description: "处理不完整，未写入结果",
      icon: TriangleAlert,
      backgroundClass: "bg-orange-50",
      textClass: "text-[#EAA65D]",
    },
    write_conflict: {
      label: "写入冲突，未完成更新",
      description: "写入冲突，未完成更新",
      icon: TriangleAlert,
      backgroundClass: "bg-orange-50",
      textClass: "text-[#EAA65D]",
    },
    failed: {
      label: "处理失败",
      description: "处理失败",
      icon: CircleX,
      backgroundClass: "bg-red-50",
      textClass: "text-red-600",
    },
    summarized: {
      label: "已生成项目总结",
      description: "已生成项目总结",
      icon: CircleCheck,
      backgroundClass: "bg-emerald-50",
      textClass: "text-[#57BC6C]",
    },
    no_commits: {
      label: "仓库读取完成，当天无新增 Commit",
      description: "仓库读取完成，当天无新增 Commit",
      icon: CircleDashed,
      backgroundClass: "bg-sky-100",
      textClass: "text-[#008AF5]",
    },
    status_updated: {
      label: "已更新项目状态",
      description: "已更新项目状态",
      icon: CircleCheck,
      backgroundClass: "bg-emerald-50",
      textClass: "text-[#57BC6C]",
    },
  }
  return presentations[outcome] ?? {
    label: "处理结果未知",
    description: `处理结果：${outcome}`,
    icon: TriangleAlert,
    backgroundClass: "bg-orange-50",
    textClass: "text-[#EAA65D]",
  }
}

function runStatusLabel(status: AutomationRun["status"]): string {
  const labels: Record<AutomationRun["status"], string> = {
    pending: "等待执行",
    claimed: "已领取",
    running: "运行中",
    succeeded: "成功",
    partial_failed: "部分失败",
    failed: "失败",
    configuration_error: "配置错误",
    cancelled: "已取消",
    skipped: "已跳过",
    timed_out: "已超时",
  }
  return labels[status]
}

function triggerLabel(source: AutomationRun["trigger_source"]): string {
  return source === "schedule" ? "定时调度" : source === "manual" ? "手动触发" : "自动重试"
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—"
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(date)
}

function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "—"
  }
  if (value < 1000) {
    return `${value} ms`
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)} 秒`
  }
  return `${Math.floor(value / 60_000)} 分 ${Math.round((value % 60_000) / 1000)} 秒`
}
