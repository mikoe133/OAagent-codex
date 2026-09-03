"use client"

import * as React from "react"
import {
  AlarmClock,
  Bolt,
  Cctv,
  History,
  ListFilter,
  Loader2,
  Search,
  Settings2,
  ShieldAlert,
  Tags,
  Timer,
} from "lucide-react"

import { AutomatedTaskConfigDialog } from "@/components/chat/automated-task-config-dialog"
import { AutomatedTaskConversation } from "@/components/chat/automated-task-conversation"
import { AutomationRunAuditDialog } from "@/components/chat/automation-run-audit-dialog"
import { AutomationRunDetailDialog } from "@/components/chat/automation-run-detail-dialog"
import { AutomationTagManagementDialog } from "@/components/chat/automation-tag-management-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { BentoGrid, type BentoItem } from "@/components/ui/bento-grid"
import { Button } from "@/components/ui/button"
import Dialog11 from "@/components/ui/dialog-projectstarter"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import PillMorphTabs, { type PillTab } from "@/components/ui/pill-morph-tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AutomationApiError,
  type AutomationJob,
  type AutomationModelCatalog,
  type AutomationRun,
  type AutomationRunTraceEvent,
  type AutomationTag,
  getAutomationJob,
  getAutomationModelCatalog,
  getAutomationRun,
  getAutomationRunTrace,
  listAutomationJobs,
  listAutomationRuns,
  listAutomationTags,
} from "@/lib/automation-api"
import {
  hasPollableAutomationRuns,
  isActiveAutomationRun,
  shouldRefreshAutomationRunDetail,
} from "@/lib/automation-run-presentation"

type TaskDialogMode = "edit" | null

type LoadTaskConversationOptions = {
  background?: boolean
  previousRuns?: AutomationRun[]
}

type LoadRunDetailOptions = {
  background?: boolean
}

export function AutomatedTasksView({ oaNavigationUrl }: { oaNavigationUrl: string }) {
  const [jobs, setJobs] = React.useState<AutomationJob[]>([])
  const [modelCatalog, setModelCatalog] = React.useState<AutomationModelCatalog | null>(null)
  const [tags, setTags] = React.useState<AutomationTag[]>([])
  const [isLoading, setIsLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [searchQuery, setSearchQuery] = React.useState("")
  const [tagFilter, setTagFilter] = React.useState("all")
  const [taskDialogMode, setTaskDialogMode] = React.useState<TaskDialogMode>(null)
  const [selectedTask, setSelectedTask] = React.useState<AutomationJob | undefined>()
  const [selectedTaskRuns, setSelectedTaskRuns] = React.useState<AutomationRun[]>([])
  const [isTaskDetailLoading, setIsTaskDetailLoading] = React.useState(false)
  const [taskDetailError, setTaskDetailError] = React.useState<string | null>(null)
  const [isRunDialogOpen, setIsRunDialogOpen] = React.useState(false)
  const [selectedRun, setSelectedRun] = React.useState<AutomationRun | null>(null)
  const [selectedRunId, setSelectedRunId] = React.useState<string | null>(null)
  const [isRunLoading, setIsRunLoading] = React.useState(false)
  const [runError, setRunError] = React.useState<string | null>(null)
  const [auditWarning, setAuditWarning] = React.useState<string | null>(null)
  const [runTrace, setRunTrace] = React.useState<AutomationRunTraceEvent[]>([])
  const [isRunTraceLoading, setIsRunTraceLoading] = React.useState(false)
  const [runTraceError, setRunTraceError] = React.useState<string | null>(null)
  const [isRunAuditOpen, setIsRunAuditOpen] = React.useState(false)
  const [isTagManagementOpen, setIsTagManagementOpen] = React.useState(false)
  const [isTaskConfigOpen, setIsTaskConfigOpen] = React.useState(false)
  const [conversationTask, setConversationTask] = React.useState<AutomationJob | null>(null)
  const [conversationRuns, setConversationRuns] = React.useState<AutomationRun[]>([])
  const [isConversationLoading, setIsConversationLoading] = React.useState(false)
  const [conversationError, setConversationError] = React.useState<string | null>(null)
  const [conversationAuditWarning, setConversationAuditWarning] = React.useState<string | null>(null)
  const conversationRequestRef = React.useRef(0)
  const runDetailRequestRef = React.useRef(0)
  const traceUnsupportedRef = React.useRef(false)

  const loadOverview = React.useCallback(async () => {
    setIsLoading(true)
    setLoadError(null)
    try {
      const [jobPage, catalog, tagPage] = await Promise.all([
        listAutomationJobs({ includeDeleted: true }),
        getAutomationModelCatalog(),
        listAutomationTags(),
      ])
      setJobs(jobPage.items)
      setModelCatalog(catalog)
      setTags(tagPage.items)
    } catch (error) {
      setLoadError(resolvePageError(error))
    } finally {
      setIsLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const openEditDialog = React.useCallback(async (jobId: number, includeDeleted = false) => {
    setSelectedTask(undefined)
    setSelectedTaskRuns([])
    setTaskDetailError(null)
    setTaskDialogMode("edit")
    setIsTaskDetailLoading(true)
    try {
      const [task, runPage] = await Promise.all([
        getAutomationJob(jobId, { includeDeleted }),
        listAutomationRuns(jobId),
      ])
      setSelectedTask(task)
      setSelectedTaskRuns(runPage.items)
    } catch (error) {
      setTaskDetailError(resolvePageError(error))
    } finally {
      setIsTaskDetailLoading(false)
    }
  }, [])

  const loadTaskConversation = React.useCallback(async (
    task: AutomationJob,
    options: LoadTaskConversationOptions = {},
  ) => {
    const requestId = ++conversationRequestRef.current
    const background = options.background === true
    if (!background) {
      setIsConversationLoading(true)
      setConversationError(null)
      setConversationAuditWarning(null)
    }

    try {
      const runPage = await listAutomationRuns({ jobId: task.id, page: 1, size: 20 })
      const previousRunsById = new Map(
        (options.previousRuns ?? []).map((run) => [run.id, run]),
      )
      let hasAuditRestriction = false
      let hasPartialFailure = false
      const detailedRuns = await Promise.all(runPage.items.map(async (run) => {
        const previousRun = previousRunsById.get(run.id)
        if (
          background &&
          previousRun &&
          !shouldRefreshAutomationRunDetail(run, previousRun)
        ) {
          return previousRun
        }
        try {
          return await getAutomationRun(run.id)
        } catch (error) {
          if (error instanceof AutomationApiError && error.status === 403) {
            hasAuditRestriction = true
            try {
              return await getAutomationRun(run.id, "attempts")
            } catch {
              return run
            }
          }
          hasPartialFailure = true
          return run
        }
      }))

      if (requestId !== conversationRequestRef.current) {
        return
      }
      setConversationError(null)
      setConversationRuns(detailedRuns)
      if (hasAuditRestriction) {
        setConversationAuditWarning("当前 OA 账号缺少 automation:audit 权限，部分 AI 请求与回复内容已隐藏。")
      } else if (hasPartialFailure) {
        setConversationAuditWarning("部分运行详情暂时无法读取，当前仅展示可用的运行状态。")
      } else {
        setConversationAuditWarning(null)
      }
    } catch (error) {
      if (requestId === conversationRequestRef.current) {
        setConversationError(resolvePageError(error))
        if (!background) {
          setConversationRuns([])
        }
      }
    } finally {
      if (!background && requestId === conversationRequestRef.current) {
        setIsConversationLoading(false)
      }
    }
  }, [])

  const openTaskConversation = React.useCallback((task: AutomationJob) => {
    setConversationTask(task)
    setConversationRuns([])
    void loadTaskConversation(task)
  }, [loadTaskConversation])

  React.useEffect(() => {
    if (
      !conversationTask ||
      isConversationLoading ||
      !hasPollableAutomationRuns(conversationRuns)
    ) {
      return
    }
    let requestInFlight = false
    const timer = window.setInterval(() => {
      if (!hasPollableAutomationRuns(conversationRuns)) {
        window.clearInterval(timer)
        return
      }
      if (requestInFlight) {
        return
      }
      requestInFlight = true
      void loadTaskConversation(conversationTask, {
        background: true,
        previousRuns: conversationRuns,
      }).finally(() => {
        requestInFlight = false
      })
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [conversationRuns, conversationTask, isConversationLoading, loadTaskConversation])

  const closeTaskConversation = React.useCallback(() => {
    conversationRequestRef.current += 1
    setConversationTask(null)
    setConversationRuns([])
    setConversationError(null)
    setConversationAuditWarning(null)
    setIsConversationLoading(false)
  }, [])

  const refreshSelectedTask = React.useCallback(async (jobId: number, includeDeleted = false) => {
    const [task, runPage, jobPage] = await Promise.all([
      getAutomationJob(jobId, { includeDeleted }),
      listAutomationRuns(jobId),
      listAutomationJobs({ includeDeleted: true }),
    ])
    setSelectedTask(task)
    setSelectedTaskRuns(runPage.items)
    setJobs(jobPage.items)
  }, [])

  const handleTaskChanged = React.useCallback(async (task: AutomationJob) => {
    setSelectedTask(task)
    setConversationTask((currentTask) => currentTask?.id === task.id ? task : currentTask)
    await loadOverview()
  }, [loadOverview])

  const handleTagsChanged = React.useCallback((nextTags: AutomationTag[]) => {
    setTags(nextTags)
    void listAutomationJobs({ includeDeleted: true }).then((jobPage) => {
      setJobs(jobPage.items)
    }).catch((error) => {
      setLoadError(resolvePageError(error))
    })
  }, [])

  const handleTriggered = React.useCallback(async () => {
    if (selectedTask) {
      await refreshSelectedTask(selectedTask.id, selectedTask.deleted)
    }
    if (conversationTask) {
      await loadTaskConversation(conversationTask)
    }
  }, [conversationTask, loadTaskConversation, refreshSelectedTask, selectedTask])

  const loadRunDetail = React.useCallback(async (
    runId: string,
    options: LoadRunDetailOptions = {},
  ) => {
    const requestId = ++runDetailRequestRef.current
    const background = options.background === true
    if (!background) {
      setIsRunLoading(true)
      setIsRunTraceLoading(true)
      setRunError(null)
      setRunTraceError(null)
      setAuditWarning(null)
    }
    try {
      const run = await getAutomationRun(runId)
      if (requestId === runDetailRequestRef.current) {
        setSelectedRun(run)
      }
    } catch (error) {
      if (error instanceof AutomationApiError && error.status === 403) {
        try {
          const run = await getAutomationRun(runId, "attempts")
          if (requestId === runDetailRequestRef.current) {
            setSelectedRun(run)
            setAuditWarning("当前 OA 账号缺少 automation:audit 权限，项目明细与完整 AI 对话审计已隐藏。")
          }
        } catch (fallbackError) {
          if (requestId === runDetailRequestRef.current) {
            setRunError(resolvePageError(fallbackError))
          }
        }
      } else if (requestId === runDetailRequestRef.current) {
        setRunError(resolvePageError(error))
      }
    } finally {
      if (!background && requestId === runDetailRequestRef.current) {
        setIsRunLoading(false)
      }
    }

    if (!traceUnsupportedRef.current) {
      try {
        const tracePage = await getAutomationRunTrace(runId)
        if (requestId === runDetailRequestRef.current) {
          setRunTrace(tracePage.items)
          setRunTraceError(null)
        }
      } catch (error) {
        if (error instanceof AutomationApiError && error.status === 404) {
          traceUnsupportedRef.current = true
        }
        if (requestId === runDetailRequestRef.current) {
          setRunTraceError(resolveRunTraceError(error))
        }
      } finally {
        if (!background && requestId === runDetailRequestRef.current) {
          setIsRunTraceLoading(false)
        }
      }
    } else if (!background && requestId === runDetailRequestRef.current) {
      setIsRunTraceLoading(false)
    }
  }, [])

  const openRunDetail = React.useCallback(async (runId: string) => {
    traceUnsupportedRef.current = false
    setSelectedRunId(runId)
    setSelectedRun(null)
    setRunTrace([])
    setIsRunDialogOpen(true)
    await loadRunDetail(runId)
  }, [loadRunDetail])

  React.useEffect(() => {
    if (
      !isRunDialogOpen ||
      !selectedRunId ||
      !selectedRun ||
      !isActiveAutomationRun(selectedRun)
    ) {
      return
    }
    let requestInFlight = false
    const timer = window.setInterval(() => {
      if (requestInFlight) {
        return
      }
      requestInFlight = true
      void loadRunDetail(selectedRunId, { background: true }).finally(() => {
        requestInFlight = false
      })
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [isRunDialogOpen, loadRunDetail, selectedRun, selectedRunId])

  const handleRunCancelled = React.useCallback(async () => {
    if (selectedRunId) {
      await openRunDetail(selectedRunId)
    }
    if (selectedTask) {
      await refreshSelectedTask(selectedTask.id, selectedTask.deleted)
    }
    if (conversationTask) {
      await loadTaskConversation(conversationTask)
    }
  }, [conversationTask, loadTaskConversation, openRunDetail, refreshSelectedTask, selectedRunId, selectedTask])

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase("zh-CN")
  const filteredJobs = jobs.filter((job) => {
    const matchesQuery = !normalizedQuery || [job.name, job.description, job.job_key]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    const matchesTag = tagFilter === "all" || job.tags.some((tag) => String(tag.id) === tagFilter)
    return matchesQuery && matchesTag
  })

  const createCards = React.useCallback((items: AutomationJob[]): BentoItem[] => (
    items.map((job) => {
      const Icon = job.job_type === "weekly_report_project_summary_sync" ? Cctv : AlarmClock
      const iconClassName = job.deleted ? "h-4 w-4 text-rose-400" : job.enabled ? "h-4 w-4 text-sky-500" : "h-4 w-4 text-stone-400"
      return {
        title: job.display_name ?? job.name,
        meta: describeNextRun(job),
        metaIcon: <Timer className="h-3.5 w-3.5 shrink-0" />,
        description: job.description || "未填写任务说明",
        icon: <Icon className={iconClassName} />,
        status: job.deleted ? "已删除" : job.enabled ? configurationStatusLabel(job.configuration_status) : "已暂停",
        tags: job.tags.map((tag) => tag.name),
        onSelect: () => openTaskConversation(job),
        onClick: () => void openEditDialog(job.id, job.deleted),
      }
    })
  ), [openEditDialog, openTaskConversation])

  const activeJobs = filteredJobs.filter((job) => !job.deleted)
  const deletedJobs = filteredJobs.filter((job) => job.deleted)
  const allCards = createCards(activeJobs)
  const enabledCards = createCards(activeJobs.filter((job) => job.enabled))
  const pausedCards = createCards(activeJobs.filter((job) => !job.enabled))
  const deletedCards = createCards(deletedJobs)
  const tabItems: PillTab[] = [
    { value: "all", label: `全部 ${activeJobs.length}`, panel: <TaskPanel cards={allCards} emptyText="暂无自动任务" /> },
    { value: "enabled", label: `已开启 ${enabledCards.length}`, panel: <TaskPanel cards={enabledCards} emptyText="暂无已开启的自动任务" /> },
    { value: "paused", label: `已暂停 ${pausedCards.length}`, panel: <TaskPanel cards={pausedCards} emptyText="暂无已暂停的自动任务" /> },
    { value: "deleted", label: `已删除 ${deletedCards.length}`, panel: <TaskPanel cards={deletedCards} emptyText="暂无已删除的自动任务" /> },
  ]

  return (
    <main
      data-slot="automated-tasks-view"
      className="h-full overflow-y-auto bg-stone-50 px-5 pb-12 pt-20 text-slate-950 theme-dark:bg-zinc-950 theme-dark:text-zinc-100 sm:px-9 sm:pt-7"
    >
      {conversationTask ? (
        <AutomatedTaskConversation
          task={conversationTask}
          runs={conversationRuns}
          loading={isConversationLoading}
          error={conversationError}
          auditWarning={conversationAuditWarning}
          oaNavigationUrl={oaNavigationUrl}
          onBack={closeTaskConversation}
          onEdit={() => void openEditDialog(conversationTask.id, conversationTask.deleted)}
          onRefresh={() => void loadTaskConversation(conversationTask)}
          onRunSelected={openRunDetail}
        />
      ) : (
        <>
          <header data-slot="automated-tasks-header" className="flex min-h-9 items-center justify-between gap-4 sm:pl-8">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">自动任务</h1>
            </div>
          </header>

          {loadError ? (
            <Alert variant="destructive" className="mt-8">
              <ShieldAlert />
              <AlertTitle>无法读取自动任务</AlertTitle>
              <AlertDescription className="flex items-start justify-between gap-4">
                <span>{loadError}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview()}>
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : isLoading ? (
            <TaskListSkeleton />
          ) : (
            <div className="mt-8">
              <PillMorphTabs
                items={tabItems}
                defaultValue="all"
                actions={
                  <div
                    data-slot="automated-task-actions"
                    className="flex w-full flex-wrap items-center gap-3 lg:flex-nowrap xl:w-auto"
                  >
                    <div data-slot="automated-task-filter-toolbar" className="contents">
                      <div className="relative w-full sm:w-72 lg:w-64 xl:w-72">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                        <Input
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                          placeholder="搜索任务名称或说明"
                          aria-label="搜索自动任务"
                          className="h-11 rounded-full bg-stone-100 pl-9 theme-dark:bg-zinc-900"
                        />
                      </div>
                      <Select value={tagFilter} onValueChange={setTagFilter}>
                        <SelectTrigger className="h-11 w-auto min-w-36 rounded-full bg-stone-100 theme-dark:bg-zinc-900" aria-label="按标签筛选">
                          <ListFilter className="h-4 w-4" />
                          <SelectValue placeholder="全部标签" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部标签</SelectItem>
                          {tags.map((tag) => <SelectItem key={tag.id} value={String(tag.id)}>{tag.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          data-slot="automated-task-management-menu"
                          type="button"
                          variant="outline"
                          size="icon"
                          aria-label="打开任务管理菜单"
                          className="h-11 w-11 rounded-full"
                        >
                          <Bolt className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48 rounded-xl p-1">
                        <DropdownMenuItem onSelect={() => setIsTagManagementOpen(true)} className="h-10 rounded-lg">
                          <Tags className="h-4 w-4" />
                          标签管理
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setIsRunAuditOpen(true)} className="h-10 rounded-lg">
                          <History className="h-4 w-4" />
                          运行审计
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setIsTaskConfigOpen(true)} className="h-10 rounded-lg">
                          <Settings2 className="h-4 w-4" />
                          任务能力管理
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                }
              />
            </div>
          )}
        </>
      )}

      <Dialog11
        open={taskDialogMode !== null}
        mode={taskDialogMode ?? "edit"}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setSelectedTask(undefined)
            setSelectedTaskRuns([])
            setTaskDetailError(null)
            setTaskDialogMode(null)
          }
        }}
        task={selectedTask}
        loading={isTaskDetailLoading}
        loadError={taskDetailError}
        modelCatalog={modelCatalog}
        tags={tags}
        runs={selectedTaskRuns}
        onTaskChanged={handleTaskChanged}
        onTagsChanged={handleTagsChanged}
        onTriggered={handleTriggered}
        onRunSelected={openRunDetail}
      />

      <AutomationRunDetailDialog
        open={isRunDialogOpen}
        onOpenChange={setIsRunDialogOpen}
        run={selectedRun}
        traceEvents={runTrace}
        traceLoading={isRunTraceLoading}
        traceError={runTraceError}
        loading={isRunLoading}
        error={runError}
        auditWarning={auditWarning}
        onCancelled={handleRunCancelled}
      />

      <AutomationTagManagementDialog
        open={isTagManagementOpen}
        onOpenChange={setIsTagManagementOpen}
        tags={tags}
        onTagsChanged={handleTagsChanged}
      />

      <AutomatedTaskConfigDialog
        open={isTaskConfigOpen}
        onOpenChange={setIsTaskConfigOpen}
      />

      <AutomationRunAuditDialog
        open={isRunAuditOpen}
        onOpenChange={setIsRunAuditOpen}
        tags={tags}
        modelCatalog={modelCatalog}
        onRunSelected={openRunDetail}
      />
    </main>
  )
}

function TaskPanel({ cards, emptyText }: { cards: BentoItem[]; emptyText: string }) {
  if (!cards.length) {
    return <p className="py-14 text-center text-sm text-stone-400 theme-dark:text-zinc-500">{emptyText}</p>
  }
  return <BentoGrid items={cards} className="mx-0 max-w-none p-0" />
}

function TaskListSkeleton() {
  return (
    <div className="mt-8 space-y-5" aria-label="正在加载自动任务">
      <div className="flex gap-3"><Skeleton className="h-11 w-56 rounded-full" /><Skeleton className="h-11 w-36 rounded-full" /></div>
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((item) => <Skeleton key={item} className="h-44 rounded-xl" />)}
      </div>
    </div>
  )
}

function resolvePageError(error: unknown): string {
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号没有自动化任务权限。请由管理员授予 automation:read；新建和修改还需要 automation:write，手动运行需要 automation:trigger。"
  }
  if (error instanceof AutomationApiError && error.status === 401) {
    return "OA 登录状态已失效，请重新登录后再试。"
  }
  return error instanceof Error ? error.message : "自动任务服务暂时不可用"
}

function resolveRunTraceError(error: unknown): string {
  if (error instanceof AutomationApiError && error.status === 404) {
    return "OA 后端尚未启用运行 Trace 接口，当前仍可查看运行终态和已有审计。"
  }
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号没有运行 Trace 查看权限。"
  }
  return error instanceof Error ? error.message : "运行 Trace 暂时无法读取"
}

function describeNextRun(job: AutomationJob): string {
  if (job.deleted || !job.enabled || !job.next_run_at) {
    return "暂无下次运行"
  }
  return `下次运行：${formatFriendlyDateTime(job.next_run_at)}`
}

function formatFriendlyDateTime(value: string, now = new Date()): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const targetDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const dayDifference = Math.round((targetDay.getTime() - today.getTime()) / 86_400_000)

  if (dayDifference === 0) {
    return `今天 ${time}`
  }
  if (dayDifference === 1) {
    return `明天 ${time}`
  }
  if (dayDifference === -1) {
    return `昨天 ${time}`
  }

  const dateLabel = new Intl.DateTimeFormat("zh-CN", {
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" as const }),
    month: "long",
    day: "numeric",
  }).format(date)
  return `${dateLabel} ${time}`
}

function configurationStatusLabel(status: AutomationJob["configuration_status"]): string {
  return status === "valid" ? "已开启" : status === "invalid" ? "配置无效" : "待校验"
}
