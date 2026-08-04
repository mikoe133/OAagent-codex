"use client"

import * as React from "react"
import {
  AlarmClock,
  CheckCircle2,
  CirclePlay,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  AutomationApiError,
  type AutomationJob,
  type AutomationJobCreateInput,
  type AutomationModelCatalog,
  type AutomationRun,
  type AutomationTag,
  createAutomationJob,
  createAutomationTag,
  deleteAutomationJob,
  triggerAutomationJob,
  updateAutomationJob,
  validateAutomationJob,
} from "@/lib/automation-api"
import {
  AUTOMATION_SCHEDULE_FREQUENCY_OPTIONS,
  type AutomationScheduleFrequency,
  buildAutomationCronExpression,
  parseAutomationSchedule,
} from "@/lib/automation-schedule"
import {
  getAutomationModelOptions,
  getAutomationProviderOptions,
  resolveAutomationModelSelection,
} from "@/lib/automation-model-options"

interface Dialog11Props {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  task?: AutomationJob
  mode?: "create" | "edit"
  loading?: boolean
  loadError?: string | null
  modelCatalog?: AutomationModelCatalog | null
  tags?: AutomationTag[]
  runs?: AutomationRun[]
  onTaskChanged?: (task: AutomationJob) => void | Promise<void>
  onTaskDeleted?: (task: AutomationJob) => void | Promise<void>
  onTagsChanged?: (tags: AutomationTag[]) => void
  onTriggered?: (runId: string) => void | Promise<void>
  onRunSelected?: (runId: string) => void
}

type TaskFormState = {
  jobKey: string
  name: string
  description: string
  cronExpression: string
  scheduleFrequency: AutomationScheduleFrequency
  executionTime: string
  timezone: string
  enabled: boolean
  modelProvider: string
  modelId: string
  tagIds: number[]
  catchUpPolicy: "skip" | "latest"
  retryMaxAttempts: string
  retryIntervalSeconds: string
  timeoutSeconds: string
  retentionDays: string
}

type PendingAction = "save" | "validate" | "trigger" | "create-tag" | "delete" | null

const DEFAULT_FORM: TaskFormState = {
  jobKey: "github-project-progress-sync",
  name: "GitHub 项目进度每日总结",
  description: "读取 OA 项目关联的 GitHub 仓库并生成当天进度总结",
  cronExpression: "0 20 * * 1-5",
  scheduleFrequency: "weekdays",
  executionTime: "20:00",
  timezone: "Asia/Shanghai",
  enabled: false,
  modelProvider: "",
  modelId: "",
  tagIds: [],
  catchUpPolicy: "latest",
  retryMaxAttempts: "3",
  retryIntervalSeconds: "300",
  timeoutSeconds: "2700",
  retentionDays: "90",
}

export default function Dialog11({
  open,
  onOpenChange,
  task,
  mode = "edit",
  loading = false,
  loadError,
  modelCatalog,
  tags = [],
  runs = [],
  onTaskChanged,
  onTaskDeleted,
  onTagsChanged,
  onTriggered,
  onRunSelected,
}: Dialog11Props) {
  const [internalOpen, setInternalOpen] = React.useState(false)
  const [form, setForm] = React.useState<TaskFormState>(DEFAULT_FORM)
  const [pendingAction, setPendingAction] = React.useState<PendingAction>(null)
  const [feedback, setFeedback] = React.useState<{ tone: "error" | "success"; text: string } | null>(null)
  const [newTagName, setNewTagName] = React.useState("")
  const dialogOpen = open ?? internalOpen
  const setDialogOpen = onOpenChange ?? setInternalOpen
  const isCreateMode = mode === "create"

  React.useEffect(() => {
    if (!dialogOpen) {
      return
    }
    setFeedback(null)
    setNewTagName("")
    if (isCreateMode) {
      const defaultModel = resolveAutomationModelSelection(modelCatalog)
      setForm({
        ...DEFAULT_FORM,
        jobKey: createAutomationJobKey(),
        modelProvider: defaultModel.provider,
        modelId: defaultModel.modelId,
      })
      return
    }
    if (task) {
      const schedule = parseAutomationSchedule(task.cron_expression)
      const taskModel = resolveAutomationModelSelection(
        modelCatalog,
        task.model_provider,
        task.model_id,
      )
      setForm({
        jobKey: task.job_key,
        name: task.name,
        description: task.description,
        cronExpression: task.cron_expression,
        scheduleFrequency: schedule.frequency,
        executionTime: schedule.executionTime,
        timezone: task.timezone,
        enabled: task.enabled,
        modelProvider: taskModel.provider,
        modelId: taskModel.modelId,
        tagIds: task.tags.map((tag) => tag.id),
        catchUpPolicy: task.catch_up_policy,
        retryMaxAttempts: String(task.retry_max_attempts ?? 3),
        retryIntervalSeconds: String(task.retry_interval_seconds ?? 300),
        timeoutSeconds: String(task.timeout_seconds ?? 2700),
        retentionDays: String(task.retention_days ?? 90),
      })
    }
  }, [dialogOpen, isCreateMode, modelCatalog, task])

  const providerOptions = getAutomationProviderOptions(modelCatalog, form.modelProvider)
  const modelOptions = getAutomationModelOptions(modelCatalog, form.modelProvider, form.modelId)
  const selectedProviderOption = providerOptions.find((option) => option.value === form.modelProvider)
  const selectedModelOption = modelOptions.find((option) => option.value === form.modelId)
  const hasUnavailableModelSelection =
    providerOptions.some((option) => option.value === form.modelProvider && !option.available) ||
    modelOptions.some((option) => option.value === form.modelId && !option.available)
  const isBusy = pendingAction !== null
  const isDeleted = Boolean(task?.deleted)
  const formDisabled = isBusy || isDeleted
  const canTrigger = Boolean(task?.enabled && task.configuration_status === "valid" && !task.deleted)

  function updateForm<Key extends keyof TaskFormState>(key: Key, value: TaskFormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isDeleted) {
      return
    }
    setPendingAction("save")
    setFeedback(null)
    try {
      const payload = buildCreateInput(form)
      const savedTask = isCreateMode
        ? await createAutomationJob(payload)
        : await updateAutomationJob(requireTask(task).id, {
            version: requireTask(task).version,
            name: payload.name,
            description: payload.description,
            enabled: payload.enabled,
            timezone: payload.timezone,
            cron_expression: payload.cron_expression,
            catch_up_policy: payload.catch_up_policy,
            model_provider: payload.model_provider,
            model_id: payload.model_id,
            model_parameters: {},
            retry_max_attempts: payload.retry_max_attempts,
            retry_interval_seconds: payload.retry_interval_seconds,
            timeout_seconds: payload.timeout_seconds,
            retention_days: payload.retention_days,
            tag_ids: payload.tag_ids,
          })
      await onTaskChanged?.(savedTask)
      setDialogOpen(false)
    } catch (error) {
      setFeedback({ tone: "error", text: resolveAutomationError(error) })
    } finally {
      setPendingAction(null)
    }
  }

  async function handleValidate() {
    if (!task) {
      return
    }
    setPendingAction("validate")
    setFeedback(null)
    try {
      const validatedTask = await validateAutomationJob(task.id)
      await onTaskChanged?.(validatedTask)
      setFeedback({ tone: "success", text: "已通过 OAagent 实时模型校验。" })
    } catch (error) {
      setFeedback({ tone: "error", text: resolveAutomationError(error) })
    } finally {
      setPendingAction(null)
    }
  }

  async function handleTrigger() {
    if (!task) {
      return
    }
    setPendingAction("trigger")
    setFeedback(null)
    try {
      const result = await triggerAutomationJob(task.id)
      await onTriggered?.(result.run_id)
      setFeedback({ tone: "success", text: `已创建手动运行 ${shortId(result.run_id)}，等待 Worker 领取。` })
    } catch (error) {
      setFeedback({ tone: "error", text: resolveAutomationError(error) })
    } finally {
      setPendingAction(null)
    }
  }

  async function handleCreateTag() {
    const name = newTagName.trim()
    if (!name) {
      return
    }
    setPendingAction("create-tag")
    setFeedback(null)
    try {
      const tag = await createAutomationTag({ name })
      onTagsChanged?.([...tags, tag])
      setForm((current) => ({ ...current, tagIds: [...current.tagIds, tag.id] }))
      setNewTagName("")
    } catch (error) {
      setFeedback({ tone: "error", text: resolveAutomationError(error) })
    } finally {
      setPendingAction(null)
    }
  }

  async function handleDelete() {
    if (!task || task.deleted) {
      return
    }
    setPendingAction("delete")
    setFeedback(null)
    try {
      const deletedTask = await deleteAutomationJob(task.id, task.version)
      await onTaskDeleted?.(deletedTask)
      setDialogOpen(false)
    } catch (error) {
      setFeedback({ tone: "error", text: resolveAutomationError(error) })
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {open === undefined ? (
        <DialogTrigger asChild>
          <Button>{isCreateMode ? "新建自动任务" : "编辑自动任务"}</Button>
        </DialogTrigger>
      ) : null}

      <DialogContent
        data-slot="automated-task-dialog"
        className="max-h-[calc(100vh-2rem)] gap-0 overflow-y-auto p-0 sm:max-w-4xl"
      >
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>{isCreateMode ? "新建自动任务" : "任务配置"}</DialogTitle>
          <DialogDescription>
            {isCreateMode
              ? "创建由 OA 调度、OAagent Worker 执行的 GitHub 项目进度任务。"
              : task
                ? `配置“${task.display_name ?? task.name}”${task.deleted ? "，该任务已删除" : ""}`
                : "正在读取 OA 中的任务详情。"}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在加载任务详情与运行记录…
          </div>
        ) : loadError ? (
          <div className="p-6">
            <Alert variant="destructive">
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="grid md:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="space-y-6 p-6">
                {feedback ? (
                  <Alert variant={feedback.tone === "error" ? "destructive" : "default"}>
                    {feedback.tone === "success" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : null}
                    <AlertDescription>{feedback.text}</AlertDescription>
                  </Alert>
                ) : null}
                {isDeleted ? (
                  <Alert>
                    <Trash2 className="h-4 w-4" />
                    <AlertDescription>
                      该任务已于 {formatDateTime(task?.deleted_at)} 软删除。配置只读，历史运行和审计仍可查询。
                    </AlertDescription>
                  </Alert>
                ) : null}
                {modelCatalog?.stale ? (
                  <Alert>
                    <AlertDescription>OAagent 模型目录当前使用过期缓存，最后缓存时间：{formatDateTime(modelCatalog.cached_at)}。</AlertDescription>
                  </Alert>
                ) : null}

                <Field label="运行状态" htmlFor="automated-task-enabled">
                  <div className="flex h-9 items-center justify-between rounded-md border px-3">
                    <span className="text-sm">{form.enabled ? "已开启" : "已暂停"}</span>
                    <Switch
                      id="automated-task-enabled"
                      checked={form.enabled}
                      onCheckedChange={(checked) => updateForm("enabled", checked)}
                      disabled={formDisabled}
                    />
                  </div>
                </Field>

                <Field label="任务名称" htmlFor="automated-task-name">
                  <Input
                    id="automated-task-name"
                    value={form.name}
                    onChange={(event) => updateForm("name", event.target.value)}
                    maxLength={255}
                    disabled={formDisabled}
                    required
                  />
                </Field>

                <Field label="任务说明" htmlFor="automated-task-description">
                  <Textarea
                    id="automated-task-description"
                    value={form.description}
                    onChange={(event) => updateForm("description", event.target.value)}
                    className="min-h-24 resize-y"
                    maxLength={4000}
                    disabled={formDisabled}
                  />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="执行频率" htmlFor="automated-task-frequency">
                    <Select
                      value={form.scheduleFrequency}
                      onValueChange={(frequency) => updateForm(
                        "scheduleFrequency",
                        frequency as AutomationScheduleFrequency,
                      )}
                      disabled={formDisabled}
                    >
                      <SelectTrigger id="automated-task-frequency" className="w-full">
                        <SelectValue placeholder="选择多久执行一次" />
                      </SelectTrigger>
                      <SelectContent>
                        {form.scheduleFrequency === "preserve-existing" ? (
                          <SelectItem value="preserve-existing">保持当前执行安排</SelectItem>
                        ) : null}
                        {AUTOMATION_SCHEDULE_FREQUENCY_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="执行时间" htmlFor="automated-task-time">
                    <Input
                      id="automated-task-time"
                      type="time"
                      step={60}
                      value={form.executionTime}
                      onChange={(event) => updateForm("executionTime", event.target.value)}
                      disabled={formDisabled || form.scheduleFrequency === "preserve-existing"}
                      required={form.scheduleFrequency !== "preserve-existing"}
                    />
                  </Field>
                </div>
                <p className="-mt-3 text-xs text-muted-foreground">
                  {form.timezone === "Asia/Shanghai" ? "按北京时间执行。" : "按任务当前所在时区执行。"}
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="模型服务商" htmlFor="automated-task-provider">
                    <Select
                      value={form.modelProvider}
                      onValueChange={(provider) => {
                        const nextProvider = modelCatalog?.providers.find((item) => item.provider === provider)
                        const nextModel = nextProvider?.models.find((model) => model.enabled && model.is_default)
                          ?? nextProvider?.models.find((model) => model.enabled)
                        setForm((current) => ({
                          ...current,
                          modelProvider: provider,
                          modelId: nextModel?.model_id ?? "",
                        }))
                      }}
                      disabled={formDisabled || !modelCatalog}
                    >
                      <SelectTrigger id="automated-task-provider" className="w-full">
                        <SelectValue placeholder="选择服务商">
                          {selectedProviderOption?.label ?? form.modelProvider}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {providerOptions.map((provider) => (
                          <SelectItem
                            key={provider.value}
                            value={provider.value}
                            disabled={!provider.available}
                          >
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="任务模型" htmlFor="automated-task-model">
                    <Select
                      value={form.modelId}
                      onValueChange={(modelId) => updateForm("modelId", modelId)}
                      disabled={formDisabled || !modelCatalog || !form.modelProvider}
                    >
                      <SelectTrigger id="automated-task-model" className="w-full">
                        <SelectValue placeholder="选择模型">
                          {selectedModelOption
                            ? `${selectedModelOption.label}${selectedModelOption.isDefault && selectedModelOption.available ? "（默认）" : ""}`
                            : form.modelId}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((model) => (
                          <SelectItem
                            key={model.value}
                            value={model.value}
                            disabled={!model.available}
                          >
                            {model.label}{model.isDefault && model.available ? "（默认）" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                {hasUnavailableModelSelection ? (
                  <p className="-mt-2 flex items-start gap-1.5 text-xs text-amber-700 theme-dark:text-amber-400">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    已回填历史模型配置，但该选项当前不可用。请选择可用的服务商和模型后保存。
                  </p>
                ) : null}

                <div className="space-y-3">
                  <Label>任务标签</Label>
                  <div className="flex flex-wrap gap-2">
                    {tags.map((tag) => {
                      const checked = form.tagIds.includes(tag.id)
                      return (
                        <label
                          key={tag.id}
                          className="flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(nextChecked) => updateForm(
                              "tagIds",
                              nextChecked === true
                                ? [...form.tagIds, tag.id]
                                : form.tagIds.filter((tagId) => tagId !== tag.id),
                            )}
                            disabled={formDisabled || (!tag.enabled && !checked)}
                          />
                          <span>{tag.name}{tag.enabled ? "" : "（已停用）"}</span>
                        </label>
                      )
                    })}
                    {tags.length === 0 ? (
                      <span className="text-sm text-muted-foreground">暂无标签，可在下方新建。</span>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      value={newTagName}
                      onChange={(event) => setNewTagName(event.target.value)}
                      placeholder="新标签名称"
                      maxLength={100}
                      disabled={formDisabled}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCreateTag}
                      disabled={!newTagName.trim() || formDisabled}
                    >
                      {pendingAction === "create-tag" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      新建标签
                    </Button>
                  </div>
                </div>
              </div>

              <aside className="border-t bg-muted/20 p-5 md:border-l md:border-t-0">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-background">
                    <AlarmClock className="h-5 w-5" />
                  </span>
                  <div>
                    <p className="text-sm font-medium">GitHub 项目进度同步</p>
                    <p className="text-xs text-muted-foreground">由 OA 调度，OAagent 执行</p>
                  </div>
                </div>

                {!isCreateMode && task ? (
                  <>
                    <div className="mt-5 space-y-2 text-sm">
                      <MetaRow label="配置" value={configurationLabel(task.configuration_status)} />
                      <MetaRow label="任务状态" value={task.deleted ? "已删除" : task.enabled ? "已开启" : "已暂停"} />
                      {task.deleted ? <MetaRow label="删除操作人" value={task.deleted_by ? `用户 #${task.deleted_by}` : "—"} /> : null}
                      <MetaRow label="下次运行" value={formatDateTime(task.next_run_at)} />
                      <MetaRow label="上次运行" value={formatDateTime(task.last_run_at)} />
                      <MetaRow label="模型" value={`${task.model_provider}/${task.model_id}`} />
                    </div>

                    {!task.deleted ? (
                      <div className="mt-5 grid gap-2">
                        <Button type="button" variant="outline" onClick={handleValidate} disabled={isBusy}>
                          {pendingAction === "validate" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          校验已保存配置
                        </Button>
                        <Button type="button" variant="outline" onClick={handleTrigger} disabled={isBusy || !canTrigger}>
                          {pendingAction === "trigger" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CirclePlay className="h-4 w-4" />}
                          立即运行
                        </Button>
                        {!canTrigger ? (
                          <p className="text-xs leading-5 text-muted-foreground">任务需开启且配置校验有效后才能手动运行。</p>
                        ) : null}
                      </div>
                    ) : null}

                    <Separator className="my-5" />
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium">最近运行</h3>
                      <Badge variant="outline">{runs.length} 条</Badge>
                    </div>
                    <div className="mt-3 space-y-2">
                      {runs.slice(0, 8).map((run) => (
                        <button
                          key={run.id}
                          type="button"
                          onClick={() => onRunSelected?.(run.id)}
                          className="w-full rounded-lg border bg-background p-3 text-left transition hover:bg-muted"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">{runStatusLabel(run.status)}</span>
                            <span className="text-[0.6875rem] text-muted-foreground">{shortId(run.id)}</span>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">{formatDateTime(run.scheduled_at)}</p>
                        </button>
                      ))}
                      {runs.length === 0 ? <p className="py-3 text-center text-xs text-muted-foreground">暂无运行记录</p> : null}
                    </div>
                  </>
                ) : (
                  <p className="mt-5 text-sm leading-6 text-muted-foreground">
                    创建时 OA 会实时校验所选模型。任务默认建议先保持暂停，联调通过后再开启。
                  </p>
                )}
              </aside>
            </div>

            <DialogFooter className="flex-row items-center border-t px-6 py-4 sm:justify-between">
              <div>
                {!isCreateMode && task && !task.deleted ? (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button type="button" variant="destructive" disabled={isBusy}>
                        <Trash2 className="h-4 w-4" />删除任务
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>软删除“{task.name}”？</AlertDialogTitle>
                        <AlertDialogDescription>
                          删除后任务会停用且无法恢复，但历史运行和审计会继续保留。存在未结束运行时 OA 会拒绝删除。
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>取消</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void handleDelete()} className="bg-destructive text-white hover:bg-destructive/90">
                          确认软删除
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                ) : null}
              </div>
              <div className="flex gap-2">
                <DialogClose asChild>
                  <Button type="button" variant="ghost" disabled={isBusy}>{isDeleted ? "关闭" : "取消"}</Button>
                </DialogClose>
                {!isDeleted ? (
                  <Button
                    type="submit"
                    disabled={isBusy || !form.modelProvider || !form.modelId || hasUnavailableModelSelection}
                  >
                    {pendingAction === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {isCreateMode ? "创建任务" : "保存更改"}
                  </Button>
                ) : null}
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

function buildCreateInput(form: TaskFormState): AutomationJobCreateInput {
  return {
    job_key: form.jobKey.trim(),
    job_type: "github_project_progress_sync",
    name: form.name.trim(),
    description: form.description.trim(),
    enabled: form.enabled,
    timezone: form.timezone.trim(),
    schedule_type: "cron",
    cron_expression: buildAutomationCronExpression(
      form.scheduleFrequency,
      form.executionTime,
      form.cronExpression,
    ),
    catch_up_policy: form.catchUpPolicy,
    overlap_policy: "forbid",
    model_provider: form.modelProvider,
    model_id: form.modelId,
    model_parameters: {},
    retry_max_attempts: Number(form.retryMaxAttempts),
    retry_interval_seconds: Number(form.retryIntervalSeconds),
    timeout_seconds: Number(form.timeoutSeconds),
    retention_days: Number(form.retentionDays),
    tag_ids: form.tagIds,
  }
}

function createAutomationJobKey(): string {
  const randomSuffix = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 10)
    : Math.random().toString(36).slice(2, 12)
  return `github-project-progress-${Date.now().toString(36)}-${randomSuffix}`
}

function requireTask(task: AutomationJob | undefined): AutomationJob {
  if (!task) {
    throw new Error("任务详情尚未加载")
  }
  return task
}

function resolveAutomationError(error: unknown): string {
  if (error instanceof AutomationApiError && error.errorCode === "job_has_active_run") {
    return "任务仍有等待、已领取或运行中的记录。请先取消运行并等待进入终态，再执行软删除。"
  }
  if (error instanceof AutomationApiError && error.errorCode === "automation_job_version_conflict") {
    return "任务已被其他人修改，请关闭窗口并重新打开后再操作。"
  }
  if (error instanceof AutomationApiError && error.status === 403) {
    return "当前 OA 账号缺少自动化操作权限，请联系管理员授予 automation:write 或 automation:admin。"
  }
  return error instanceof Error ? error.message : "自动任务操作失败"
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return "—"
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(date)
}

function configurationLabel(status: AutomationJob["configuration_status"]): string {
  return status === "valid" ? "有效" : status === "invalid" ? "无效" : "未校验"
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

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value
}
