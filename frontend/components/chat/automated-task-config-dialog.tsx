"use client"

import * as React from "react"
import { Boxes, Github, Loader2, RefreshCw, Save, TriangleAlert } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { WelcomeModal } from "@/components/ui/welcome-modal"
import {
  AutomationApiError,
  type AutomationPromptProfile,
  getAutomationPromptProfile,
  updateAutomationPromptProfile,
} from "@/lib/automation-api"

const DEFAULT_SYSTEM_PROMPT = `你是 OAAgent 的自动任务执行助手。请仅在用户明确配置的范围内执行任务，并遵循以下约束：

1. 跟踪 GitHub 项目时，只读取和更新与当前任务直接相关的项目、字段、状态和进度。
2. 调用 RWKVOS 系统功能前，确认调用目的与自动任务目标一致，不执行未授权的系统操作。
3. 遇到信息缺失、权限不足或可能造成不可逆影响的操作时，停止执行并记录原因。
4. 每次执行完成后，输出简洁、可核验的结果摘要。`
const REQUIRED_FEATURE_TOOLTIP = "该功能为自动任务必需能力，无法取消"
const PROMPT_PROFILE_JOB_TYPE = "github_project_progress_sync"

interface AutomatedTaskConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AutomatedTaskConfigDialog({
  open,
  onOpenChange,
}: AutomatedTaskConfigDialogProps) {
  const [systemPrompt, setSystemPrompt] = React.useState(DEFAULT_SYSTEM_PROMPT)
  const [enabled, setEnabled] = React.useState(true)
  const [profile, setProfile] = React.useState<AutomationPromptProfile | null>(null)
  const [isLoading, setIsLoading] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [isSaving, setIsSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [hasVersionConflict, setHasVersionConflict] = React.useState(false)
  const [isSaveConfirmationOpen, setIsSaveConfirmationOpen] = React.useState(false)
  const [confirmationText, setConfirmationText] = React.useState("")
  const loadRequestId = React.useRef(0)
  const canConfirmModification = confirmationText === "确认修改"

  const loadProfile = React.useCallback(async () => {
    const requestId = ++loadRequestId.current
    setIsLoading(true)
    setLoadError(null)
    try {
      const nextProfile = await getAutomationPromptProfile(PROMPT_PROFILE_JOB_TYPE)
      if (requestId !== loadRequestId.current) {
        return
      }
      setProfile(nextProfile)
      setSystemPrompt(nextProfile.system_prompt)
      setEnabled(nextProfile.enabled)
    } catch (error) {
      if (requestId === loadRequestId.current) {
        setLoadError(resolvePromptProfileError(error))
      }
    } finally {
      if (requestId === loadRequestId.current) {
        setIsLoading(false)
      }
    }
  }, [])

  React.useEffect(() => {
    if (!open) {
      loadRequestId.current += 1
      return
    }
    setSaveError(null)
    setHasVersionConflict(false)
    void loadProfile()
  }, [loadProfile, open])

  function handleRequestSave() {
    if (!profile || isLoading || loadError || !systemPrompt.trim()) {
      return
    }
    setConfirmationText("")
    setSaveError(null)
    setHasVersionConflict(false)
    setIsSaveConfirmationOpen(true)
  }

  function handleConfirmationOpenChange(nextOpen: boolean) {
    if (isSaving) {
      return
    }
    setIsSaveConfirmationOpen(nextOpen)
    if (!nextOpen) {
      setConfirmationText("")
    }
  }

  async function handleConfirmModification() {
    if (!canConfirmModification || !profile || isSaving) {
      return
    }

    setIsSaving(true)
    setSaveError(null)
    setHasVersionConflict(false)
    try {
      const nextProfile = await updateAutomationPromptProfile(PROMPT_PROFILE_JOB_TYPE, {
        system_prompt: systemPrompt,
        enabled,
        version: profile.version,
      })
      setProfile(nextProfile)
      setSystemPrompt(nextProfile.system_prompt)
      setEnabled(nextProfile.enabled)
      setIsSaveConfirmationOpen(false)
      setConfirmationText("")
      onOpenChange(false)
    } catch (error) {
      setSaveError(resolvePromptProfileError(error))
      setHasVersionConflict(
        error instanceof AutomationApiError &&
        error.errorCode === "automation_prompt_version_conflict",
      )
    } finally {
      setIsSaving(false)
    }
  }

  function handleMainOpenChange(nextOpen: boolean) {
    if (!nextOpen && !isSaving) {
      setIsSaveConfirmationOpen(false)
      setConfirmationText("")
      setSaveError(null)
      setHasVersionConflict(false)
      onOpenChange(false)
    }
  }

  function handleReloadProfile() {
    if (isSaving) {
      return
    }
    setIsSaveConfirmationOpen(false)
    setConfirmationText("")
    setSaveError(null)
    setHasVersionConflict(false)
    void loadProfile()
  }

  return (
    <>
      <WelcomeModal
        open={open}
        onOpenChange={handleMainOpenChange}
        title="配置自动任务约束"
        description="设置自动任务允许使用的功能，以及所有任务共享的内容约束上下文。"
        mainActionText="保存配置"
        mainActionIcon={<Save className="ml-2 h-4 w-4" />}
        onMainActionClick={handleRequestSave}
        mainActionDisabled={isLoading || Boolean(loadError) || !profile || !systemPrompt.trim()}
        showDontShowAgain={false}
        showHelp={false}
      >
        {isLoading ? (
          <div className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在读取 OA 内容约束…
          </div>
        ) : loadError ? (
          <Alert variant="destructive">
            <TriangleAlert className="h-4 w-4" />
            <AlertTitle>无法读取内容约束</AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{loadError}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void loadProfile()}>
                <RefreshCw className="h-4 w-4" />
                重新加载
              </Button>
            </AlertDescription>
          </Alert>
        ) : profile ? (
          <div className="grid gap-2 rounded-xl border bg-muted/20 p-4 text-xs text-muted-foreground sm:grid-cols-2">
            <span>配置版本：v{profile.version}</span>
            <span>提示词版本：{profile.prompt_version}</span>
            <span>最后修改：{formatDateTime(profile.updated_at)}</span>
            <span>修改人：{profile.updated_by ? `用户 #${profile.updated_by}` : "系统默认"}</span>
          </div>
        ) : null}

        <section data-slot="automated-task-supported-features" className="space-y-3">
          <div>
            <h3 className="font-semibold">支持的功能</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              以下能力为自动任务执行所必需，默认固定启用。
            </p>
          </div>

          <label
            htmlFor="github-project-tracking"
            title={REQUIRED_FEATURE_TOOLTIP}
            className="flex cursor-not-allowed items-start gap-3 rounded-xl border border-border/70 p-4 transition-colors hover:bg-muted/40"
          >
            <Checkbox
              id="github-project-tracking"
              checked
              disabled
              className="mt-1 disabled:opacity-100"
            />
            <Github className="mt-0.5 h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">GitHub 项目跟踪约束</span>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                允许自动任务读取并跟踪 GitHub Project 的进度、状态和字段变化。
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              固定启用
            </span>
          </label>

          <label
            htmlFor="rwkvos-system-calls"
            title={REQUIRED_FEATURE_TOOLTIP}
            className="flex cursor-not-allowed items-start gap-3 rounded-xl border border-border/70 p-4 transition-colors hover:bg-muted/40"
          >
            <Checkbox
              id="rwkvos-system-calls"
              checked
              disabled
              className="mt-1 disabled:opacity-100"
            />
            <Boxes className="mt-0.5 h-5 w-5 shrink-0 text-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">RWKVOS 系统功能调用</span>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                允许自动任务调用 RWKVOS 提供的系统能力完成受控操作。
              </span>
            </span>
            <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
              固定启用
            </span>
          </label>
        </section>

        <section data-slot="automated-task-context-constraints" className="space-y-3">
          <div>
            <label htmlFor="automated-task-system-prompt" className="font-semibold">
              配置自动任务内容约束上下文
            </label>
            <p className="mt-1 text-sm text-muted-foreground">
              该系统提示词会作为所有自动任务的全局执行约束，可以直接修改。
            </p>
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border/70 p-4">
            <div>
              <Label htmlFor="automated-task-prompt-enabled">应用到新运行</Label>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                关闭后，新创建的运行将使用 OAagent 内置默认提示词。
              </p>
            </div>
            <Switch
              id="automated-task-prompt-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!profile || isLoading}
            />
          </div>
          <Textarea
            id="automated-task-system-prompt"
            value={systemPrompt}
            onChange={(event) => setSystemPrompt(event.target.value)}
            className="min-h-56 resize-y font-mono text-sm leading-6"
            aria-label="自动任务系统提示词"
            maxLength={16000}
            disabled={!profile || isLoading}
          />
          <p className="text-right text-xs text-muted-foreground">{systemPrompt.length} / 16000</p>
        </section>
      </WelcomeModal>

      <Dialog open={isSaveConfirmationOpen} onOpenChange={handleConfirmationOpenChange}>
        <DialogContent
          data-slot="automated-task-save-warning"
          showCloseButton={false}
          className="gap-0 overflow-hidden p-0 sm:max-w-md"
        >
          <DialogHeader className="border-b px-6 py-5">
            <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-amber-100 text-amber-700 theme-dark:bg-amber-500/15 theme-dark:text-amber-300">
              <TriangleAlert className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle>确认修改自动任务约束</DialogTitle>
            <DialogDescription className="pt-1 leading-6">
              请勿随意修改可读 GitHub 仓库。确认操作请在输入框键入“确认修改”。
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(event) => {
              event.preventDefault()
              void handleConfirmModification()
            }}
          >
            <div className="space-y-3 px-6 py-5">
              {saveError ? (
                <Alert variant="destructive">
                  <TriangleAlert className="h-4 w-4" />
                  <AlertTitle>保存失败</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>{saveError}</p>
                    {hasVersionConflict ? (
                      <Button type="button" size="sm" variant="outline" onClick={handleReloadProfile}>
                        <RefreshCw className="h-4 w-4" />
                        重新加载最新配置
                      </Button>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Label htmlFor="confirm-automated-task-constraints">确认文本</Label>
              <Input
                id="confirm-automated-task-constraints"
                value={confirmationText}
                onChange={(event) => setConfirmationText(event.target.value)}
                placeholder="请输入“确认修改”"
                autoComplete="off"
                aria-describedby="confirm-automated-task-constraints-help"
              />
              <p
                id="confirm-automated-task-constraints-help"
                className={canConfirmModification ? "text-xs text-emerald-600" : "text-xs text-muted-foreground"}
              >
                {canConfirmModification
                  ? "确认文本正确，可以提交修改。"
                  : "只有完整输入“确认修改”后才能继续。"}
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-6 py-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => handleConfirmationOpenChange(false)}
                disabled={isSaving}
              >
                返回确认
              </Button>
              <Button type="submit" disabled={!canConfirmModification || isSaving}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {isSaving ? "正在保存" : "确认修改"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function resolvePromptProfileError(error: unknown): string {
  if (error instanceof AutomationApiError) {
    if (error.status === 401) {
      return "OA 登录状态已失效，请重新登录后再试。"
    }
    if (error.errorCode === "automation_prompt_profile_not_found") {
      return "OA 尚未初始化自动任务内容约束，请检查提示词配置数据库迁移。"
    }
    if (error.errorCode === "automation_prompt_version_conflict") {
      return "配置已被其他人修改。当前输入已保留，请重新加载最新配置后再修改。"
    }
    if (error.errorCode === "automation_prompt_invalid" || error.errorCode === "extra_forbidden") {
      return "内容约束未通过 OA 校验，请检查文本长度和不可见控制字符。"
    }
    return error.message
  }
  return error instanceof Error ? error.message : "自动任务内容约束请求失败。"
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)
}
