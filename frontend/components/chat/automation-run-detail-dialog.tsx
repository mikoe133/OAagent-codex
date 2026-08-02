"use client"

import * as React from "react"
import {
  Ban,
  Bot,
  CheckCircle2,
  Clock3,
  GitCommitHorizontal,
  Loader2,
  TriangleAlert,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  cancelAutomationRun,
} from "@/lib/automation-api"

interface AutomationRunDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  run: AutomationRun | null
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
                {run.projects.length ? run.projects.map((project) => (
                  <article key={project.id} className="rounded-xl border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="font-medium">{project.project_name}</h4>
                        <p className="mt-1 text-xs text-muted-foreground">
                          项目 #{project.project_id} · {project.repository_count} 个仓库 · {project.commit_count} 条 Commit
                        </p>
                      </div>
                      <Badge variant={isSuccessfulOutcome(project.outcome) ? "secondary" : "destructive"}>
                        {project.outcome}
                      </Badge>
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

function isSuccessfulOutcome(outcome: string): boolean {
  return ["evaluated", "summarized", "no_commits", "status_updated"].includes(outcome)
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
