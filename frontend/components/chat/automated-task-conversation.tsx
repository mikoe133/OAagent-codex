"use client"

import * as React from "react"
import {
  ArrowLeft,
  CalendarClock,
  CircleAlert,
  Loader2,
  MessageSquareText,
  Pencil,
  RefreshCw,
  ShieldAlert,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MessageBubble } from "@/components/chat/message-bubble"
import type { Message } from "@/components/chat/chat-shell"
import type {
  AutomationAiInteraction,
  AutomationJob,
  AutomationRun,
} from "@/lib/automation-api"
import {
  formatAutomationPayload,
  resolveAutomationRunReply,
} from "@/lib/automation-run-presentation"

interface AutomatedTaskConversationProps {
  task: AutomationJob
  runs: AutomationRun[]
  loading: boolean
  error?: string | null
  auditWarning?: string | null
  oaNavigationUrl: string
  onBack: () => void
  onEdit: () => void
  onRefresh: () => void
  onRunSelected: (runId: string) => void
}

export function AutomatedTaskConversation({
  task,
  runs,
  loading,
  error,
  auditWarning,
  oaNavigationUrl,
  onBack,
  onEdit,
  onRefresh,
  onRunSelected,
}: AutomatedTaskConversationProps) {
  const conversationEndRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!loading && runs.length) {
      conversationEndRef.current?.scrollIntoView({ block: "end" })
    }
  }, [loading, runs])

  return (
    <section data-slot="automated-task-conversation" className="min-h-full">
      <header
        data-slot="automated-task-conversation-header"
        className="sticky top-0 z-10 -mr-3 -mt-16 ml-12 flex h-10 flex-nowrap items-center justify-between gap-2 rounded-full bg-zinc-100 px-2.5 text-stone-600 theme-dark:bg-zinc-800 theme-dark:text-zinc-300 sm:-mr-7 sm:ml-8 sm:mt-0 sm:px-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="返回自动任务列表"
            onClick={onBack}
            className="shrink-0 rounded-full"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2 whitespace-nowrap">
            <h1 className="min-w-0 truncate text-base font-semibold tracking-tight sm:text-lg">
              {task.display_name ?? task.name}
            </h1>
            <Badge variant="outline" className="hidden shrink-0 rounded-full sm:inline-flex">
              {task.deleted ? "已删除" : task.enabled ? "已开启" : "已暂停"}
            </Badge>
            <span className="shrink-0 text-xs text-stone-500 theme-dark:text-zinc-400">
              最近 {runs.length} 次运行
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="刷新任务对话"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-full hover:bg-zinc-200 theme-dark:hover:bg-zinc-700"
          >
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            aria-label="编辑任务"
            onClick={onEdit}
            className="size-9 rounded-full px-0 hover:bg-zinc-200 theme-dark:hover:bg-zinc-700 sm:w-auto sm:px-3"
          >
            <Pencil className="h-4 w-4" />
            <span className="hidden sm:inline">编辑任务</span>
          </Button>
        </div>
      </header>

      <div className="mx-auto mt-8 max-w-5xl">
        {auditWarning ? (
          <Alert className="mb-5 border-amber-200 bg-amber-50/70 theme-dark:border-amber-900 theme-dark:bg-amber-950/30">
            <ShieldAlert className="text-amber-600" />
            <AlertDescription>{auditWarning}</AlertDescription>
          </Alert>
        ) : null}

        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{error}</span>
              <Button type="button" size="sm" variant="outline" onClick={onRefresh}>重新加载</Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <ConversationSkeleton />
        ) : runs.length ? (
          <div className="space-y-10 pb-8">
            {[...runs].reverse().map((run) => (
              <RunConversation
                key={run.id}
                task={task}
                run={run}
                oaNavigationUrl={oaNavigationUrl}
                onRunSelected={onRunSelected}
              />
            ))}
            <div ref={conversationEndRef} />
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-stone-300 bg-white/60 px-6 py-16 text-center theme-dark:border-zinc-700 theme-dark:bg-zinc-900/40">
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-stone-100 text-stone-500 theme-dark:bg-zinc-800 theme-dark:text-zinc-400">
              <MessageSquareText className="h-5 w-5" />
            </span>
            <h2 className="mt-4 font-medium">暂无运行对话</h2>
            <p className="mt-2 text-sm text-stone-500 theme-dark:text-zinc-400">
              任务首次运行后，这里会按时间展示任务要求与 AI 回复。
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

function RunConversation({
  task,
  run,
  oaNavigationUrl,
  onRunSelected,
}: {
  task: AutomationJob
  run: AutomationRun
  oaNavigationUrl: string
  onRunSelected: (runId: string) => void
}) {
  const interactions = [...(run.ai_interactions ?? [])].sort((left, right) => left.id - right.id)

  return (
    <section data-slot="automated-task-run-conversation" aria-label={`运行 ${run.id}`}>
      <div className="mb-6 flex items-center gap-3 text-xs text-stone-400 theme-dark:text-zinc-500">
        <span className="h-px flex-1 bg-stone-200 theme-dark:bg-zinc-800" />
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <CalendarClock className="h-3.5 w-3.5" />
          {formatDateTime(run.started_at ?? run.scheduled_at)}
          <span aria-hidden="true">·</span>
          {runStatusLabel(run.status)}
          <span aria-hidden="true">·</span>
          第 {run.attempt} 次
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRunSelected(run.id)}
          className="h-7 rounded-full px-2 text-xs text-stone-500"
        >
          运行详情
        </Button>
        <span className="h-px flex-1 bg-stone-200 theme-dark:bg-zinc-800" />
      </div>

      <div className="space-y-7">
        {interactions.length ? interactions.map((interaction) => (
          <ConversationPair
            key={interaction.id}
            task={task}
            run={run}
            interaction={interaction}
            oaNavigationUrl={oaNavigationUrl}
          />
        )) : (
          <ConversationPair task={task} run={run} oaNavigationUrl={oaNavigationUrl} />
        )}
      </div>
    </section>
  )
}

function ConversationPair({
  task,
  run,
  interaction,
  oaNavigationUrl,
}: {
  task: AutomationJob
  run: AutomationRun
  interaction?: AutomationAiInteraction
  oaNavigationUrl: string
}) {
  const project = interaction
    ? run.projects?.find((item) => item.id === interaction.run_project_id)
    : undefined
  const interactionKey = interaction?.id ?? "run"
  const requestMessage = {
    id: `${run.id}-${interactionKey}-request`,
    role: "user",
    content: resolveRequest(task, interaction, project?.project_name),
    createdAt: parseMessageDate(run.started_at ?? run.scheduled_at),
    status: "completed",
  } satisfies Message
  const responseMessage = {
    id: `${run.id}-${interactionKey}-response`,
    role: "assistant",
    content: resolveReplyContent(run, interaction),
    createdAt: parseMessageDate(run.finished_at ?? run.started_at ?? run.scheduled_at),
    durationMs: interaction?.latency_ms ?? run.duration_ms ?? undefined,
    status: "completed",
  } satisfies Message

  return (
    <article data-slot="automated-task-conversation-pair" className="space-y-7">
      <MessageBubble message={requestMessage} showActions={false} oaNavigationUrl={oaNavigationUrl} />
      <MessageBubble message={responseMessage} showActions={false} oaNavigationUrl={oaNavigationUrl} />
    </article>
  )
}

function resolveRequest(
  task: AutomationJob,
  interaction: AutomationAiInteraction | undefined,
  projectName: string | undefined,
): string {
  const content = [
    task.description || `执行自动任务“${task.display_name ?? task.name}”。`,
    projectName ? `当前项目：${projectName}` : null,
    interaction?.request_payload_sanitized !== null && interaction?.request_payload_sanitized !== undefined
      ? `脱敏输入：\n${formatAutomationPayload(interaction.request_payload_sanitized)}`
      : null,
  ]
  return content.filter((item): item is string => Boolean(item)).join("\n\n")
}

function resolveReplyContent(run: AutomationRun, interaction?: AutomationAiInteraction): string {
  const reply = resolveAutomationRunReply(run, interaction)
  if (
    !interaction?.final_summary?.trim() ||
    interaction.response_payload_sanitized === null ||
    interaction.response_payload_sanitized === undefined
  ) {
    return reply
  }

  return `${reply}\n\n**脱敏响应**\n\n\`\`\`json\n${formatAutomationPayload(interaction.response_payload_sanitized)}\n\`\`\``
}

function parseMessageDate(value: string | null | undefined): Date {
  return new Date(value ?? "")
}

function ConversationSkeleton() {
  return (
    <div className="space-y-8" aria-label="正在加载任务对话">
      {[0, 1].map((item) => (
        <div key={item} className="space-y-5 animate-pulse">
          <div className="ml-auto h-28 w-2/3 rounded-2xl bg-stone-200/70 theme-dark:bg-zinc-800" />
          <div className="flex items-start gap-3">
            <span className="size-8 rounded-full bg-stone-200/70 theme-dark:bg-zinc-800" />
            <div className="h-32 flex-1 rounded-2xl bg-white theme-dark:bg-zinc-900" />
          </div>
        </div>
      ))}
      <div className="flex items-center justify-center gap-2 text-sm text-stone-500 theme-dark:text-zinc-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在整理任务与 AI 的运行对话…
      </div>
    </div>
  )
}

function runStatusLabel(status: AutomationRun["status"]): string {
  const labels: Record<AutomationRun["status"], string> = {
    pending: "等待执行",
    claimed: "已领取",
    running: "运行中",
    succeeded: "运行成功",
    partial_failed: "部分失败",
    failed: "运行失败",
    configuration_error: "配置错误",
    cancelled: "已取消",
    skipped: "已跳过",
    timed_out: "已超时",
  }
  return labels[status]
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "时间未知"
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
}
