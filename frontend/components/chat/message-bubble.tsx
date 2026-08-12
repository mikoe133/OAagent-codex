"use client"

import * as AccordionPrimitive from "@radix-ui/react-accordion"
import { useEffect, useRef, useState } from "react"
import Image from "next/image"
import {
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Copy,
  ExternalLink,
  GitCompareArrows,
  Globe2,
  LoaderCircle,
  MessageSquareText,
  Plus,
  SearchCode,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
} from "lucide-react"

import { Accordion, AccordionContent, AccordionItem } from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatResponseDuration } from "@/lib/response-duration"
import { cn } from "@/lib/utils"
import type { Message } from "./chat-shell"
import type { ToolStep, ToolStepStatus, TraceMessage } from "./chat-stream"
import { MarkdownRenderer } from "./markdown-renderer"
import { AnimatedOrb } from "./animated-orb"

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  showActions?: boolean
  onFeedback?: (messageId: string, feedback: Message["feedback"]) => void
  oaNavigationUrl: string
}

function formatTime(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    return ""
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

const MESSAGE_ACTION_CONTROLS_CLASS =
  "flex items-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none pointer-fine:pointer-events-none pointer-fine:translate-y-0.5 pointer-fine:opacity-0 pointer-fine:group-hover/message:pointer-events-auto pointer-fine:group-hover/message:translate-y-0 pointer-fine:group-hover/message:opacity-100 pointer-fine:group-focus-within/message:pointer-events-auto pointer-fine:group-focus-within/message:translate-y-0 pointer-fine:group-focus-within/message:opacity-100"
const TRACE_SUMMARY_MAX_CHARS = 48

export function MessageBubble({
  message,
  isStreaming = false,
  showActions = true,
  onFeedback,
  oaNavigationUrl,
}: MessageBubbleProps) {
  const isUser = message.role === "user"
  const assistantIsStreaming = !isUser && (isStreaming || message.status === "streaming")
  const toolSteps = message.toolSteps ?? []
  const hasAssistantText = message.content.trim().length > 0
  const latestToolStepId = toolSteps[toolSteps.length - 1]?.id
  const traceMessages = message.traceMessages?.length
    ? message.traceMessages
    : assistantIsStreaming && hasAssistantText
      ? [
          {
            id: "message-current",
            content: message.content,
            ...(latestToolStepId ? { afterStepId: latestToolStepId } : {}),
          },
        ]
      : []

  return (
    <article
      className={cn(
        "group/message flex gap-3",
        isUser
          ? "ml-auto max-w-[min(88%,42rem)] flex-row-reverse user-message-enter"
          : "mr-auto w-full max-w-[52rem] animate-in items-start fade-in slide-in-from-bottom-2 duration-300",
      )}
      aria-label={isUser ? "Your message" : "OA Agent response"}
    >
      <div className={cn("min-w-0", isUser ? "flex flex-col items-end" : "flex-1")}>
        {isUser ? (
          <div
            data-slot="user-message-bubble"
            className="max-w-full rounded-2xl rounded-tr-md bg-[#f5f5f5] px-4 py-3 text-stone-800 theme-dark:bg-zinc-800 theme-dark:text-zinc-100"
          >
            <div className="flex flex-col gap-2">
              {message.imageData && (
                <div className="h-24 w-24 overflow-hidden rounded-lg border border-stone-200 bg-white theme-dark:border-zinc-700 theme-dark:bg-zinc-900">
                  <Image
                    src={message.imageData || "/placeholder.svg"}
                    alt="Uploaded image"
                    width={96}
                    height={96}
                    className="h-full w-full object-cover"
                  />
                </div>
              )}
              <p className="whitespace-pre-wrap break-words text-[0.9375rem] leading-6">{message.content}</p>
            </div>
          </div>
        ) : (
          <div className="min-w-0 max-w-full">
            {(toolSteps.length > 0 || traceMessages.length > 0) && (
              <ToolTimeline
                steps={toolSteps}
                isStreaming={assistantIsStreaming}
                traceMessages={traceMessages}
                fallbackText={message.content}
                status={message.status}
              />
            )}
            {assistantIsStreaming && (
              <span className="sr-only" role="status">
                Generating response
              </span>
            )}
            {hasAssistantText && !assistantIsStreaming && (
              <div data-slot="assistant-response">
                <MarkdownRenderer content={message.content} className={cn(toolSteps.length > 0 && "mt-4")} />
              </div>
            )}
            {message.status === "failed" && (
              <div className="mt-3 flex max-w-2xl items-start gap-2 rounded-lg border border-rose-200 bg-rose-50/70 px-3 py-2 text-xs leading-5 text-rose-700 theme-dark:border-rose-900 theme-dark:bg-rose-950/40 theme-dark:text-rose-300">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{message.error || "The response was interrupted before it could finish."}</span>
              </div>
            )}
            {message.status === "stopped" && (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-stone-500 theme-dark:text-zinc-400">
                <CircleStop className="h-3.5 w-3.5" aria-hidden="true" />
                Generation stopped
              </div>
            )}
          </div>
        )}

        {showActions ? (
          isUser ? (
            <UserActions message={message} />
          ) : (
            <AssistantActions
              message={message}
              isStreaming={assistantIsStreaming}
              onFeedback={onFeedback}
              oaNavigationUrl={oaNavigationUrl}
            />
          )
        ) : null}
      </div>
    </article>
  )
}

function UserActions({ message }: { message: Message }) {
  const showCopy = message.content.trim().length > 0

  return (
            <div className="mt-1.5 flex min-h-7 items-center justify-end gap-1 text-[0.6875rem] text-stone-400 theme-dark:text-zinc-500">
      <span>{formatTime(message.createdAt)}</span>
      {showCopy && (
        <span data-slot="message-actions" className={MESSAGE_ACTION_CONTROLS_CLASS}>
          <span className="mx-1 h-3 w-px bg-stone-200 theme-dark:bg-zinc-700" aria-hidden="true" />
          <MessageCopyButton content={message.content} subject="message" />
        </span>
      )}
    </div>
  )
}

function AssistantActions({
  message,
  isStreaming,
  onFeedback,
  oaNavigationUrl,
}: {
  message: Message
  isStreaming: boolean
  onFeedback?: MessageBubbleProps["onFeedback"]
  oaNavigationUrl: string
}) {
  const responseDuration = formatResponseDuration(message.durationMs)
  const showActions =
    !isStreaming &&
    message.content.trim().length > 0 &&
    (message.status === undefined || message.status === "completed")

  const toggleFeedback = (feedback: NonNullable<Message["feedback"]>) => {
    onFeedback?.(message.id, message.feedback === feedback ? null : feedback)
  }

  return (
            <div className="mt-2 flex min-h-7 items-center gap-1 text-[0.6875rem] text-stone-400 theme-dark:text-zinc-500">
      {responseDuration && <span>{`已处理: ${responseDuration}`}</span>}
      {showActions && (
        <span data-slot="message-actions" className={MESSAGE_ACTION_CONTROLS_CLASS}>
          <span className="mx-1 h-3 w-px bg-stone-200 theme-dark:bg-zinc-700" aria-hidden="true" />
          <MessageCopyButton content={message.content} subject="response" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleFeedback("like")}
                aria-label="Like response"
                aria-pressed={message.feedback === "like"}
                className={cn(
                  "h-7 w-7 rounded-md text-stone-400 hover:bg-emerald-50 hover:text-emerald-700 theme-dark:text-zinc-500 theme-dark:hover:bg-emerald-950/50 theme-dark:hover:text-emerald-400",
                  message.feedback === "like" && "bg-emerald-50 text-emerald-700 theme-dark:bg-emerald-950/50 theme-dark:text-emerald-400",
                )}
              >
                <ThumbsUp className={cn("h-3.5 w-3.5", message.feedback === "like" && "fill-current")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>Helpful</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => toggleFeedback("dislike")}
                aria-label="Dislike response"
                aria-pressed={message.feedback === "dislike"}
                className={cn(
                  "h-7 w-7 rounded-md text-stone-400 hover:bg-rose-50 hover:text-rose-700 theme-dark:text-zinc-500 theme-dark:hover:bg-rose-950/50 theme-dark:hover:text-rose-400",
                  message.feedback === "dislike" && "bg-rose-50 text-rose-700 theme-dark:bg-rose-950/50 theme-dark:text-rose-400",
                )}
              >
                <ThumbsDown className={cn("h-3.5 w-3.5", message.feedback === "dislike" && "fill-current")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>Not helpful</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 rounded-md text-stone-400 hover:bg-sky-50 hover:text-sky-700 theme-dark:text-zinc-500 theme-dark:hover:bg-sky-950/50 theme-dark:hover:text-sky-400"
              >
                <a
                  href={oaNavigationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Open OA"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>Open OA</TooltipContent>
          </Tooltip>
        </span>
      )}
    </div>
  )
}

function MessageCopyButton({ content, subject }: { content: string; subject: "message" | "response" }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle")
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current)
      }
    }
  }, [])

  const handleCopy = async () => {
    try {
      await copyText(content)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 1800)
  }

  const idleLabel = subject === "message" ? "Copy message" : "Copy response"
  const copiedLabel = subject === "message" ? "Message copied" : "Response copied"
  const ariaLabel = copyState === "copied" ? copiedLabel : copyState === "failed" ? "Copy failed" : idleLabel

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCopy}
          aria-label={ariaLabel}
          className="h-7 w-7 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-700 theme-dark:text-zinc-500 theme-dark:hover:bg-zinc-800 theme-dark:hover:text-zinc-200"
        >
          {copyState === "copied" ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
      </TooltipContent>
    </Tooltip>
  )
}

export function resolveTraceOpenState(
  currentOpen: boolean,
  activity: { wasActive: boolean; isActive: boolean },
): boolean {
  return activity.isActive && !activity.wasActive ? true : currentOpen
}

function ToolTimeline({
  steps,
  isStreaming,
  traceMessages,
  fallbackText,
  status,
}: {
  steps: ToolStep[]
  isStreaming: boolean
  traceMessages: TraceMessage[]
  fallbackText: string
  status: Message["status"]
}) {
  const hasRunningStep = steps.some((step) => step.status === "running")
  const failedCount = steps.filter((step) => step.status === "failed").length
  const timelineItems = buildTraceTimelineItems(steps, traceMessages)
  const activeMessageId = traceMessages[traceMessages.length - 1]?.id
  const isTraceActive = isStreaming || hasRunningStep
  const traceState = isTraceActive
    ? "active"
    : status === "failed"
      ? "failed"
      : failedCount > 0
        ? "warning"
        : "idle"
  const wasTraceActiveRef = useRef(isTraceActive)
  const [isOpen, setIsOpen] = useState(isTraceActive)

  useEffect(() => {
    const wasActive = wasTraceActiveRef.current
    wasTraceActiveRef.current = isTraceActive
    setIsOpen((currentOpen) => resolveTraceOpenState(currentOpen, { wasActive, isActive: isTraceActive }))
  }, [isTraceActive])

  const summaryText = isTraceActive
    ? resolveTraceSummaryText(traceMessages, fallbackText, steps)
    : status === "failed"
      ? "Failed"
      : status === "stopped"
        ? "Stopped"
        : failedCount > 0
          ? "Completed with warnings"
          : "Completed"

  return (
    <Accordion
      type="single"
      collapsible
      value={isOpen ? "agent-trace" : ""}
      onValueChange={(value) => setIsOpen(value === "agent-trace")}
      data-slot="agent-trace"
      className="w-full max-w-2xl"
    >
      <AccordionItem value="agent-trace" data-slot="agent-trace-item" className="border-0 py-2">
        <AccordionPrimitive.Header className="flex">
          <AccordionPrimitive.Trigger
            data-slot="agent-trace-trigger"
            className="flex min-h-14 flex-1 items-center justify-between gap-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 [&>svg>path:last-child]:origin-center [&>svg>path:last-child]:transition-all [&>svg>path:last-child]:duration-200 [&[data-state=open]>svg>path:last-child]:rotate-90 [&[data-state=open]>svg>path:last-child]:opacity-0 [&[data-state=open]>svg]:rotate-180"
            aria-label="Toggle agent trace"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div
                data-slot="trace-summary-icon"
                data-trace-state={traceState}
                className={cn(
                  "relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full",
                  traceState === "active"
                    ? ""
                    : traceState === "failed"
                      ? "bg-rose-50 text-rose-700 theme-dark:bg-rose-950/50 theme-dark:text-rose-300"
                      : traceState === "warning"
                        ? "bg-amber-50 text-amber-700 theme-dark:bg-amber-950/50 theme-dark:text-amber-300"
                        : "bg-stone-100 text-stone-600 theme-dark:bg-zinc-800 theme-dark:text-zinc-300",
                )}
                aria-hidden="true"
              >
                {isTraceActive && (
                  <div data-slot="trace-summary-orb" className="absolute inset-0">
                    <AnimatedOrb size={40} />
                  </div>
                )}
                {!isTraceActive && <GitCompareArrows className="h-4 w-4" />}
              </div>
              <span className="block min-w-0 flex-1 truncate text-[0.8125rem] font-normal leading-5 text-stone-500 theme-dark:text-zinc-400">
                {summaryText}
              </span>
            </div>
            <Plus
              className="h-4 w-4 shrink-0 text-stone-400 transition-transform duration-200 theme-dark:text-zinc-500"
              strokeWidth={2}
              aria-hidden="true"
            />
          </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
        <AccordionContent
          className="ml-3 pb-2 pl-10 pt-1"
          aria-label="Agent trace"
        >
          <div className="space-y-3">
            {timelineItems.map((item) =>
              item.kind === "tool" ? (
                <ToolTimelineItem
                  key={`tool-${item.step.id}`}
                  step={item.step}
                />
              ) : (
                <StreamingMessageTrace
                  key={`message-${item.message.id}`}
                  message={item.message}
                  isActive={isStreaming && item.message.id === activeMessageId}
                />
              ),
            )}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

export function resolveTraceSummaryText(
  messages: TraceMessage[],
  fallbackText: string,
  steps: ToolStep[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content.trim()
    if (content) {
      return truncateTraceSummaryText(content)
    }
  }

  const fallback = fallbackText.trim()
  if (fallback) {
    return truncateTraceSummaryText(fallback)
  }

  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    const content = step?.description.trim() || step?.title.trim()
    if (content) {
      return truncateTraceSummaryText(content)
    }
  }

  return ""
}

export function truncateTraceSummaryText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim()
  const characters = Array.from(text)

  if (characters.length <= TRACE_SUMMARY_MAX_CHARS) {
    return text
  }

  return `${characters.slice(0, TRACE_SUMMARY_MAX_CHARS).join("")}...`
}

type TraceTimelineItem =
  | { kind: "tool"; step: ToolStep }
  | { kind: "message"; message: TraceMessage }

function buildTraceTimelineItems(steps: ToolStep[], messages: TraceMessage[]): TraceTimelineItem[] {
  const stepIds = new Set(steps.map((step) => step.id))
  const messagesByStep = new Map<string, TraceMessage[]>()
  const leadingMessages: TraceMessage[] = []

  for (const message of messages) {
    if (!message.afterStepId || !stepIds.has(message.afterStepId)) {
      leadingMessages.push(message)
      continue
    }

    const relatedMessages = messagesByStep.get(message.afterStepId) ?? []
    relatedMessages.push(message)
    messagesByStep.set(message.afterStepId, relatedMessages)
  }

  const timelineItems: TraceTimelineItem[] = leadingMessages.map((message) => ({ kind: "message", message }))
  for (const step of steps) {
    timelineItems.push({ kind: "tool", step })
    for (const message of messagesByStep.get(step.id) ?? []) {
      timelineItems.push({ kind: "message", message })
    }
  }

  return timelineItems
}

function StreamingMessageTrace({
  message,
  isActive,
}: {
  message: TraceMessage
  isActive: boolean
}) {
  return (
    <div
      data-slot="streaming-message-trace"
      data-trace-message-id={message.id}
      className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5"
    >
      <span
        data-slot="trace-message-icon"
        className="relative z-10 flex h-7 w-7 items-center justify-center rounded-md bg-stone-50 theme-dark:bg-zinc-900"
      >
        <MessageSquareText className="h-3.5 w-3.5 text-stone-400 theme-dark:text-zinc-500" aria-hidden="true" />
      </span>
      <div className="min-w-0 pt-0.5 opacity-80" aria-label="Agent thinking">
        <MarkdownRenderer
          content={message.content}
          isStreaming={isActive}
          className="font-light italic text-xs leading-5 text-stone-400 theme-dark:text-zinc-500 [&_blockquote]:text-stone-400 theme-dark:[&_blockquote]:text-zinc-500 [&_h1]:text-stone-500 theme-dark:[&_h1]:text-zinc-400 [&_h2]:text-stone-500 theme-dark:[&_h2]:text-zinc-400 [&_h3]:text-stone-500 theme-dark:[&_h3]:text-zinc-400 [&_strong]:font-normal [&_strong]:text-stone-500 theme-dark:[&_strong]:text-zinc-400"
        />
      </div>
    </div>
  )
}

function ToolTimelineItem({ step }: { step: ToolStep }) {
  const hasDetails = Boolean(step.input || step.output)

  return (
    <div className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2.5">
      <span
        data-slot="trace-tool-icon"
        className="relative z-10 flex h-7 w-7 items-center justify-center rounded-md bg-white theme-dark:bg-zinc-950"
      >
        <ToolIcon step={step} />
      </span>
      <div className="min-w-0 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs font-semibold text-stone-800 theme-dark:text-zinc-200">{step.title}</span>
          <span
            data-slot="trace-tool-status"
            className={cn("text-[0.625rem] font-medium uppercase", statusClass(step.status))}
          >
            {statusLabel(step.status)}
          </span>
        </div>
        <p className="mt-0.5 break-words text-xs leading-5 text-stone-500 theme-dark:text-zinc-400">{step.description}</p>
        {hasDetails && (
          <details className="group mt-1.5" open={step.status === "running"}>
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[0.6875rem] font-medium text-stone-500 transition-colors hover:text-stone-800 theme-dark:text-zinc-400 theme-dark:hover:text-zinc-200">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true" />
              Details
            </summary>
            <div className="mt-2 space-y-2 border-l border-stone-200 pl-3 theme-dark:border-zinc-700">
              {step.input && <ToolDetail label="Input" value={step.input} />}
              {step.output && <ToolDetail label={step.status === "failed" ? "Error" : "Output"} value={step.output} />}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

function ToolDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
          <div className="mb-1 text-[0.625rem] font-semibold uppercase text-stone-400 theme-dark:text-zinc-500">{label}</div>
          <pre className="max-h-56 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-stone-950 px-3 py-2 font-mono text-[0.6875rem] leading-5 text-stone-100">
        {value}
      </pre>
    </div>
  )
}

function ToolIcon({ step }: { step: ToolStep }) {
  if (step.status === "running") {
    return <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#b4fbde]" aria-hidden="true" />
  }
  if (step.status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-[#00BFFF]" aria-hidden="true" />
  }
  if (step.status === "failed") {
    return <CircleAlert className="h-3.5 w-3.5 text-rose-600 theme-dark:text-rose-400" aria-hidden="true" />
  }
  if (step.type === "command_execution") {
    return <Terminal className="h-3.5 w-3.5 text-stone-500 theme-dark:text-zinc-400" aria-hidden="true" />
  }
  if (step.type === "web_search") {
    return <Globe2 className="h-3.5 w-3.5 text-stone-500 theme-dark:text-zinc-400" aria-hidden="true" />
  }
  if (step.type === "mcp_tool_call") {
    return <SearchCode className="h-3.5 w-3.5 text-stone-500 theme-dark:text-zinc-400" aria-hidden="true" />
  }
  return <Wrench className="h-3.5 w-3.5 text-stone-500 theme-dark:text-zinc-400" aria-hidden="true" />
}

function statusLabel(status: ToolStepStatus): string {
  if (status === "running") return "Running"
  if (status === "completed") return "Complete"
  if (status === "failed") return "Failed"
  return "Update"
}

function statusClass(status: ToolStepStatus): string {
  if (status === "running") return "text-[#c6e5ec] theme-dark:text-cyan-300"
  if (status === "completed") return "text-[#00619a] theme-dark:text-sky-400"
  if (status === "failed") return "text-rose-700 theme-dark:text-rose-400"
  return "text-stone-400 theme-dark:text-zinc-500"
}

async function copyText(value: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is unavailable")
  }

  const textarea = document.createElement("textarea")
  textarea.value = value
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand("copy")
  textarea.remove()

  if (!copied) {
    throw new Error("Copy failed")
  }
}
