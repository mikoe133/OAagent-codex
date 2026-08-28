"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight, History, Loader2, RefreshCw, Search } from "lucide-react"

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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AutomationApiError,
  type AutomationModelCatalog,
  type AutomationRun,
  type AutomationRunStatus,
  type AutomationTag,
  listAutomationRuns,
} from "@/lib/automation-api"

interface AutomationRunAuditDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tags: AutomationTag[]
  modelCatalog: AutomationModelCatalog | null
  onRunSelected: (runId: string) => void
}

type RunFilters = {
  status: "all" | AutomationRunStatus
  triggerSource: "all" | AutomationRun["trigger_source"]
  tagId: string
  modelProvider: string
  modelId: string
  startedAfter: string
  startedBefore: string
}

const DEFAULT_FILTERS: RunFilters = {
  status: "all",
  triggerSource: "all",
  tagId: "all",
  modelProvider: "all",
  modelId: "all",
  startedAfter: "",
  startedBefore: "",
}

const RUN_STATUSES: AutomationRunStatus[] = [
  "pending",
  "claimed",
  "running",
  "succeeded",
  "partial_failed",
  "failed",
  "configuration_error",
  "cancelled",
  "skipped",
  "timed_out",
]

export function AutomationRunAuditDialog({
  open,
  onOpenChange,
  tags,
  modelCatalog,
  onRunSelected,
}: AutomationRunAuditDialogProps) {
  const [draftFilters, setDraftFilters] = React.useState<RunFilters>(DEFAULT_FILTERS)
  const [appliedFilters, setAppliedFilters] = React.useState<RunFilters>(DEFAULT_FILTERS)
  const [runs, setRuns] = React.useState<AutomationRun[]>([])
  const [total, setTotal] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [isLoading, setIsLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = React.useState(0)
  const pageSize = 10

  React.useEffect(() => {
    if (!open) {
      return
    }
    let active = true
    setIsLoading(true)
    setError(null)
    void listAutomationRuns({
      page,
      size: pageSize,
      status: appliedFilters.status === "all" ? undefined : appliedFilters.status,
      triggerSource: appliedFilters.triggerSource === "all" ? undefined : appliedFilters.triggerSource,
      tagId: appliedFilters.tagId === "all" ? undefined : Number(appliedFilters.tagId),
      modelProvider: appliedFilters.modelProvider === "all" ? undefined : appliedFilters.modelProvider,
      modelId: appliedFilters.modelId === "all" ? undefined : appliedFilters.modelId,
      startedAfter: toIsoDateTime(appliedFilters.startedAfter),
      startedBefore: toIsoDateTime(appliedFilters.startedBefore),
    }).then((result) => {
      if (active) {
        setRuns(result.items)
        setTotal(result.total)
      }
    }).catch((failure) => {
      if (active) {
        setError(resolveRunError(failure))
      }
    }).finally(() => {
      if (active) {
        setIsLoading(false)
      }
    })
    return () => {
      active = false
    }
  }, [appliedFilters, open, page, refreshVersion])

  const selectedProvider = modelCatalog?.providers.find(
    (provider) => provider.provider === draftFilters.modelProvider,
  )
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  function updateDraft<Key extends keyof RunFilters>(key: Key, value: RunFilters[Key]) {
    setDraftFilters((current) => ({ ...current, [key]: value }))
  }

  function applyFilters() {
    setPage(1)
    setAppliedFilters(draftFilters)
  }

  function resetFilters() {
    setDraftFilters(DEFAULT_FILTERS)
    setAppliedFilters(DEFAULT_FILTERS)
    setPage(1)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="automation-run-audit-dialog" className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="flex items-center gap-2"><History className="h-5 w-5" />运行审计</DialogTitle>
          <DialogDescription>查询全部任务的调度、手动触发和重试记录，包括已删除任务的历史。</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 p-6">
          <section className="grid gap-3 rounded-xl border bg-muted/20 p-4 md:grid-cols-3">
            <FilterSelect label="运行状态" value={draftFilters.status} onValueChange={(value) => updateDraft("status", value as RunFilters["status"])}>
              <SelectItem value="all">全部状态</SelectItem>
              {RUN_STATUSES.map((status) => <SelectItem key={status} value={status}>{runStatusLabel(status)}</SelectItem>)}
            </FilterSelect>
            <FilterSelect label="触发方式" value={draftFilters.triggerSource} onValueChange={(value) => updateDraft("triggerSource", value as RunFilters["triggerSource"])}>
              <SelectItem value="all">全部方式</SelectItem>
              <SelectItem value="schedule">定时调度</SelectItem>
              <SelectItem value="manual">手动触发</SelectItem>
              <SelectItem value="retry">自动重试</SelectItem>
            </FilterSelect>
            <FilterSelect label="任务标签" value={draftFilters.tagId} onValueChange={(value) => updateDraft("tagId", value)}>
              <SelectItem value="all">全部标签</SelectItem>
              {tags.map((tag) => <SelectItem key={tag.id} value={String(tag.id)}>{tag.name}</SelectItem>)}
            </FilterSelect>
            <FilterSelect label="模型服务商" value={draftFilters.modelProvider} onValueChange={(value) => {
              setDraftFilters((current) => ({ ...current, modelProvider: value, modelId: "all" }))
            }}>
              <SelectItem value="all">全部服务商</SelectItem>
              {modelCatalog?.providers.map((provider) => <SelectItem key={provider.provider} value={provider.provider}>{provider.display_name}</SelectItem>)}
            </FilterSelect>
            <FilterSelect label="模型" value={draftFilters.modelId} onValueChange={(value) => updateDraft("modelId", value)} disabled={draftFilters.modelProvider === "all"}>
              <SelectItem value="all">全部模型</SelectItem>
              {selectedProvider?.models.map((model) => <SelectItem key={model.model_id} value={model.model_id}>{model.display_name}</SelectItem>)}
            </FilterSelect>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="run-started-after">开始时间从</Label>
                <Input id="run-started-after" type="datetime-local" value={draftFilters.startedAfter} onChange={(event) => updateDraft("startedAfter", event.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="run-started-before">开始时间到</Label>
                <Input id="run-started-before" type="datetime-local" value={draftFilters.startedBefore} onChange={(event) => updateDraft("startedBefore", event.target.value)} />
              </div>
            </div>
            <div className="flex items-end gap-2 md:col-span-3 md:justify-end">
              <Button type="button" variant="ghost" onClick={resetFilters}>重置</Button>
              <Button type="button" onClick={applyFilters}><Search className="h-4 w-4" />查询</Button>
              <Button type="button" variant="outline" size="icon" aria-label="刷新运行审计" onClick={() => setRefreshVersion((value) => value + 1)}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>
          </section>

          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}

          <section className="space-y-2">
            {isLoading ? (
              <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />正在加载运行记录…</div>
            ) : runs.length ? runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => onRunSelected(run.id)}
                className="grid w-full gap-3 rounded-xl border p-4 text-left transition hover:bg-muted/40 md:grid-cols-[minmax(0,1.5fr)_1fr_1fr_auto] md:items-center"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{run.job_display_name ?? run.job_name}</span>
                    {run.job_deleted ? <Badge variant="outline">已删除任务</Badge> : null}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{run.id}</p>
                </div>
                <div className="text-sm">
                  <p>{runStatusLabel(run.status)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{triggerLabel(run.trigger_source)} · 第 {run.attempt} 次</p>
                </div>
                <div className="text-sm">
                  <p>{run.model_provider}/{run.model_id}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(run.started_at ?? run.scheduled_at)}</p>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {run.projects_succeeded}/{run.projects_total} 项目
                </div>
              </button>
            )) : <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">没有符合条件的运行记录</p>}
          </section>
        </div>

        <DialogFooter className="flex-row items-center justify-between border-t px-6 py-4 sm:justify-between">
          <span className="text-sm text-muted-foreground">共 {total} 条 · 第 {page}/{totalPages} 页</span>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="icon" aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1 || isLoading}><ChevronLeft className="h-4 w-4" /></Button>
            <Button type="button" variant="outline" size="icon" aria-label="下一页" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages || isLoading}><ChevronRight className="h-4 w-4" /></Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilterSelect({
  label,
  value,
  onValueChange,
  disabled,
  children,
}: {
  label: string
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  )
}

function toIsoDateTime(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString()
}

function resolveRunError(error: unknown): string {
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号缺少 automation:read 权限，无法查询运行审计。"
  }
  return error instanceof Error ? error.message : "运行审计查询失败"
}

function runStatusLabel(status: AutomationRunStatus): string {
  const labels: Record<AutomationRunStatus, string> = {
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
  return source === "schedule" ? "定时调度" : source === "event" ? "事件触发" : source === "manual" ? "手动触发" : "自动重试"
}

function formatDateTime(value: string): string {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(parsed)
}
