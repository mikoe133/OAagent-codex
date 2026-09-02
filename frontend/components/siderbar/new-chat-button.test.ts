import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const siderSource = readFileSync(new URL("./Sider.tsx", import.meta.url), "utf8")
const chatShellSource = readFileSync(new URL("../chat/chat-shell.tsx", import.meta.url), "utf8")
const automatedTasksSource = readFileSync(new URL("../chat/automated-tasks-view.tsx", import.meta.url), "utf8")
const automatedTaskConversationSource = readFileSync(new URL("../chat/automated-task-conversation.tsx", import.meta.url), "utf8")
const messageBubbleSource = readFileSync(new URL("../chat/message-bubble.tsx", import.meta.url), "utf8")
const automatedTaskConfigSource = readFileSync(new URL("../chat/automated-task-config-dialog.tsx", import.meta.url), "utf8")
const welcomeModalSource = readFileSync(new URL("../ui/welcome-modal.tsx", import.meta.url), "utf8")
const runAuditSource = readFileSync(new URL("../chat/automation-run-audit-dialog.tsx", import.meta.url), "utf8")
const runDetailSource = readFileSync(new URL("../chat/automation-run-detail-dialog.tsx", import.meta.url), "utf8")
const tagManagementSource = readFileSync(new URL("../chat/automation-tag-management-dialog.tsx", import.meta.url), "utf8")
const bentoGridSource = readFileSync(new URL("../ui/bento-grid.tsx", import.meta.url), "utf8")
const taskDialogSource = readFileSync(new URL("../ui/dialog-projectstarter.tsx", import.meta.url), "utf8")
const pillMorphTabsSource = readFileSync(new URL("../ui/pill-morph-tabs.tsx", import.meta.url), "utf8")

test("places search, new chat, and scheduled actions on separate full-width rows", () => {
  const actionRowIndex = siderSource.indexOf('data-slot="sider-actions"')
  const searchIndex = siderSource.indexOf("<SearchBox")
  const newChatIndex = siderSource.indexOf('data-slot="new-chat-button"')
  const scheduledIndex = siderSource.indexOf('data-slot="scheduled-button"')
  const sessionListIndex = siderSource.indexOf("ref={sessionListRef}")
  const actionRow = siderSource.match(
    /<div\s+data-slot="sider-actions"[\s\S]*?<SearchBox[\s\S]*?data-slot="new-chat-button"[\s\S]*?data-slot="scheduled-button"[\s\S]*?<\/div>/,
  )?.[0]

  assert.notEqual(actionRowIndex, -1, "expected the sider action stack")
  assert.ok(actionRow, "expected all three actions in one vertical stack")
  assert.match(actionRow, /flex-col/)
  assert.match(actionRow, /px-1/)
  assert.match(actionRow, /md:px-5/)
  assert.doesNotMatch(actionRow, /grid-cols-/)
  assert.doesNotMatch(actionRow, /border-b/)
  assert.ok(searchIndex < newChatIndex, "expected search before new chat")
  assert.ok(newChatIndex < scheduledIndex, "expected new chat before scheduled")
  assert.ok(scheduledIndex < sessionListIndex, "expected all actions above the session list")
})

test("styles the new chat button as a transparent left-aligned hover row", () => {
  const newChatButton = siderSource.match(
    /<button[\s\S]*?data-slot="new-chat-button"[\s\S]*?<\/button>/,
  )?.[0]

  assert.ok(newChatButton, "expected the sider new chat button")
  assert.match(newChatButton, /onClick=\{onNewSession\}/)
  assert.match(newChatButton, /border-0/)
  assert.match(newChatButton, /rounded-lg/)
  assert.match(newChatButton, /w-full/)
  assert.match(newChatButton, /justify-start/)
  assert.match(newChatButton, /px-3/)
  assert.match(newChatButton, /text-left/)
  assert.match(newChatButton, /bg-transparent/)
  assert.match(newChatButton, /text-\[#565657\]/)
  assert.match(newChatButton, /hover:bg-stone-100\/70/)
  assert.match(newChatButton, /新建对话/)
})

test("places a full-width scheduled button below the search row", () => {
  const scheduledButton = siderSource.match(
    /<button[\s\S]*?data-slot="scheduled-button"[\s\S]*?<Clock[\s\S]*?自动任务[\s\S]*?<\/button>/,
  )?.[0]

  assert.ok(scheduledButton, "expected the scheduled button")
  assert.match(scheduledButton, /type="button"/)
  assert.match(scheduledButton, /onClick=\{onOpenAutomatedTasks\}/)
  assert.match(scheduledButton, /w-full/)
  assert.match(scheduledButton, /justify-start/)
  assert.match(scheduledButton, /px-3/)
  assert.match(scheduledButton, /text-left/)
  assert.match(scheduledButton, /bg-transparent/)
  assert.match(scheduledButton, /text-\[#565657\]/)
  assert.match(scheduledButton, /hover:bg-stone-100\/70/)
  assert.match(scheduledButton, /<Clock/)
  assert.match(scheduledButton, /自动任务/)
})

test("switches the right pane from chat to the automated task list", () => {
  assert.match(siderSource, /onOpenAutomatedTasks: \(\) => void/)
  assert.match(chatShellSource, /type WorkspaceView = "conversation" \| "automated-tasks"/)
  assert.match(chatShellSource, /setActiveWorkspaceView\("automated-tasks"\)/)
  assert.match(chatShellSource, /onOpenAutomatedTasks=\{handleOpenAutomatedTasks\}/)
  assert.match(chatShellSource, /activeWorkspaceView === "automated-tasks"[\s\S]*?<AutomatedTasksView/)
  assert.match(chatShellSource, /<AutomatedTasksView oaNavigationUrl=\{oaNavigationUrl\}/)
  assert.match(chatShellSource, /activeWorkspaceView === "conversation"[\s\S]*?<Composer/)
})

test("renders the automated task page from OA data", () => {
  assert.match(automatedTasksSource, /data-slot="automated-tasks-view"/)
  assert.match(automatedTasksSource, /data-slot="automated-tasks-header"/)
  assert.match(automatedTasksSource, />自动任务<\/h1>/)
  assert.match(automatedTasksSource, /data-slot="automated-task-filter-toolbar"/)
  assert.match(automatedTasksSource, /data-slot="automated-task-actions"/)
  assert.match(automatedTasksSource, /import \{ BentoGrid, type BentoItem \}/)
  assert.doesNotMatch(automatedTasksSource, /const AUTOMATED_TASKS/)
  assert.match(automatedTasksSource, /listAutomationJobs\(\{ includeDeleted: true \}\)/)
  assert.match(automatedTasksSource, /getAutomationModelCatalog\(\)/)
  assert.match(automatedTasksSource, /listAutomationTags\(\)/)
  assert.match(automatedTasksSource, /<PillMorphTabs/)
  assert.match(automatedTasksSource, /items=\{tabItems\}/)
  assert.match(automatedTasksSource, /defaultValue="all"/)
  assert.match(automatedTasksSource, /resolvePageError/)
  assert.match(automatedTasksSource, /automation:read/)
})

test("uses the cctv icon for weekly report monitor cards", () => {
  assert.match(automatedTasksSource, /import \{[\s\S]*Cctv[\s\S]*\} from "lucide-react"/)
  assert.match(automatedTasksSource, /job\.job_type === "weekly_report_project_summary_sync" \? Cctv : AlarmClock/)
  assert.match(taskDialogSource, /import \{[\s\S]*Cctv[\s\S]*\} from "lucide-react"/)
  assert.match(taskDialogSource, /form\.jobType === "weekly_report_project_summary_sync" \? <Cctv/)
})

test("opens the original automated task constraints configuration modal from the management menu", () => {
  const configIndex = automatedTasksSource.indexOf("任务能力管理")

  assert.notEqual(configIndex, -1, "expected the management menu")
  assert.match(automatedTasksSource, /import \{ AutomatedTaskConfigDialog \}/)
  assert.match(automatedTasksSource, /data-slot="automated-task-management-menu"/)
  assert.match(automatedTasksSource, /<Bolt/)
  assert.match(automatedTasksSource, /<DropdownMenuContent/)
  assert.match(automatedTasksSource, /<Settings2/)
  assert.match(automatedTasksSource, /任务能力管理/)
  assert.match(automatedTasksSource, /setIsTaskConfigOpen\(true\)/)
  assert.match(automatedTasksSource, /<AutomatedTaskConfigDialog/)
  assert.match(welcomeModalSource, /export interface WelcomeModalProps/)
  assert.match(welcomeModalSource, /showDontShowAgain/)
  assert.match(welcomeModalSource, /showHelp/)
  assert.match(automatedTaskConfigSource, /title="配置自动任务约束"/)
  assert.match(automatedTaskConfigSource, /data-slot="automated-task-supported-features"/)
  assert.match(automatedTaskConfigSource, /GitHub 项目跟踪约束/)
  assert.match(automatedTaskConfigSource, /RWKVOS 系统功能调用/)
  assert.match(automatedTaskConfigSource, /checked[\s\S]*?disabled/)
  assert.match(automatedTaskConfigSource, /固定启用/)
  assert.match(automatedTaskConfigSource, /data-slot="automated-task-context-constraints"/)
  assert.match(automatedTaskConfigSource, /id="automated-task-system-prompt"/)
  assert.match(automatedTaskConfigSource, /value=\{systemPrompt\}/)
  assert.match(automatedTaskConfigSource, /mainActionText="保存配置"/)
  assert.match(automatedTaskConfigSource, /onMainActionClick=\{handleRequestSave\}/)
  assert.match(automatedTaskConfigSource, /getAutomationPromptProfile\(PROMPT_PROFILE_JOB_TYPE\)/)
  assert.match(automatedTaskConfigSource, /updateAutomationPromptProfile\(PROMPT_PROFILE_JOB_TYPE/)
  assert.match(automatedTaskConfigSource, /version: profile\.version/)
  assert.match(automatedTaskConfigSource, /automation_prompt_version_conflict/)
  assert.match(automatedTaskConfigSource, /重新加载最新配置/)
  assert.match(automatedTaskConfigSource, /maxLength=\{16000\}/)
  assert.match(automatedTaskConfigSource, /data-slot="automated-task-save-warning"/)
  assert.match(automatedTaskConfigSource, /请勿随意修改可读 GitHub 仓库/)
  assert.match(automatedTaskConfigSource, /placeholder="请输入“确认修改”"/)
  assert.match(automatedTaskConfigSource, /disabled=\{!canConfirmModification \|\| isSaving\}/)
  assert.match(automatedTaskConfigSource, />\s*返回确认\s*</)
  assert.match(automatedTaskConfigSource, /\{isSaving \? "正在保存" : "确认修改"\}/)
})

test("keeps the automated task title clear of floating sidebar controls", () => {
  const taskHeader = automatedTasksSource.match(
    /<header[\s\S]*?data-slot="automated-tasks-header"[\s\S]*?<\/header>/,
  )?.[0]

  assert.ok(taskHeader, "expected a dedicated automated task header")
  assert.match(taskHeader, /min-h-9/)
  assert.match(taskHeader, /sm:pl-8/)
  assert.match(
    chatShellSource,
    /activeWorkspaceView === "conversation" \? \([\s\S]*?aria-label="New chat"[\s\S]*?\) : null/,
  )
})

test("places filters before task actions and hides the refresh control", () => {
  const filterToolbarIndex = automatedTasksSource.indexOf('data-slot="automated-task-filter-toolbar"')
  const tabsIndex = automatedTasksSource.indexOf("<PillMorphTabs")
  const managementMenuIndex = automatedTasksSource.indexOf('data-slot="automated-task-management-menu"')
  const createTaskIndex = automatedTasksSource.indexOf('data-slot="create-automated-task-button"')

  assert.match(pillMorphTabsSource, /actions\?: React\.ReactNode/)
  assert.match(pillMorphTabsSource, /data-slot="pill-morph-header"/)
  assert.match(pillMorphTabsSource, /flex flex-wrap items-center justify-start gap-3/)
  assert.match(pillMorphTabsSource, /\{actions\}/)
  assert.ok(tabsIndex < filterToolbarIndex, "expected filters inside the tab action row")
  assert.equal(createTaskIndex, -1, "expected creation to stay hidden")
  assert.match(automatedTasksSource, /data-slot="automated-task-actions"[\s\S]*?lg:flex-nowrap[\s\S]*?data-slot="automated-task-filter-toolbar"[\s\S]*?<Search[\s\S]*?<Select/)
  assert.doesNotMatch(automatedTasksSource, /RefreshCw|刷新自动任务/)
  assert.ok(filterToolbarIndex < managementMenuIndex, "expected filters left of management menu")
})

test("filters automated task cards with pill-morph tabs", () => {
  assert.match(automatedTasksSource, /import PillMorphTabs, \{ type PillTab \}/)
  assert.match(automatedTasksSource, /label: `全部 \$\{activeJobs\.length\}`/)
  assert.match(automatedTasksSource, /label: `已开启 \$\{enabledCards\.length\}`/)
  assert.match(automatedTasksSource, /label: `已暂停 \$\{pausedCards\.length\}`/)
  assert.match(automatedTasksSource, /label: `已删除 \$\{deletedCards\.length\}`/)
  assert.match(automatedTasksSource, /job\.tags\.some/)
  assert.match(automatedTasksSource, /setSearchQuery/)
  assert.match(automatedTasksSource, /setTagFilter/)
  assert.match(pillMorphTabsSource, /from "motion\/react"/)
  assert.match(pillMorphTabsSource, /const \[indicator, setIndicator\]/)
  assert.match(pillMorphTabsSource, /new ResizeObserver\(measure\)/)
  assert.match(pillMorphTabsSource, /<motion\.div/)
  assert.match(pillMorphTabsSource, /<TabsContent/)
  assert.match(pillMorphTabsSource, /data-slot="pill-morph-glow"/)
  assert.match(pillMorphTabsSource, /data-slot="pill-morph-track"/)
  assert.match(pillMorphTabsSource, /data-slot="pill-morph-indicator"/)
  assert.match(pillMorphTabsSource, /top-1\/2 z-0 h-16/)
  assert.match(pillMorphTabsSource, /linear-gradient\(90deg, #7c3aed, #06b6d4\)/)
  assert.match(pillMorphTabsSource, /bg-stone-100\/95/)
  assert.match(pillMorphTabsSource, /bg-white shadow-/)
  assert.doesNotMatch(pillMorphTabsSource, /overflow-x-auto/)
})

test("opens the task form dialog from each bento card action", () => {
  assert.match(automatedTasksSource, /const \[selectedTask, setSelectedTask\]/)
  assert.match(automatedTasksSource, /const openEditDialog = React\.useCallback/)
  assert.match(automatedTasksSource, /getAutomationJob\(jobId, \{ includeDeleted \}\)/)
  assert.match(automatedTasksSource, /listAutomationRuns\(jobId\)/)
  assert.match(automatedTasksSource, /<Dialog11/)
  assert.match(automatedTasksSource, /open=\{taskDialogMode !== null\}/)
  assert.match(automatedTasksSource, /mode=\{taskDialogMode \?\? "edit"\}/)
  assert.match(bentoGridSource, /onClick\?: \(\) => void/)
  assert.match(bentoGridSource, /import \{ EllipsisVertical \} from "lucide-react"/)
  assert.match(bentoGridSource, /data-slot="bento-grid-item-action"/)
  assert.match(bentoGridSource, /aria-label=\{`编辑任务：\$\{item\.title\}`\}/)
  assert.match(bentoGridSource, /md:opacity-0 md:group-hover:opacity-100/)
  assert.match(bentoGridSource, /onClick=\{item\.onClick\}/)
  assert.match(bentoGridSource, /data-slot="bento-grid-item-select"/)
  assert.match(bentoGridSource, /className="absolute inset-0 z-10 rounded-xl/)
  assert.match(taskDialogSource, /data-slot="automated-task-dialog"/)
  assert.match(taskDialogSource, /createAutomationJob\(payload\)/)
  assert.doesNotMatch(taskDialogSource, /任务标识|automated-task-key/)
  assert.doesNotMatch(taskDialogSource, /<DialogDescription>[\s\S]{0,400}?task\.job_key/)
  assert.match(taskDialogSource, /jobKey: createAutomationJobKey\(\)/)
  assert.match(taskDialogSource, /function createAutomationJobKey\(\)/)
  assert.match(taskDialogSource, /job_key: form\.jobKey\.trim\(\)/)
  assert.match(taskDialogSource, /updateAutomationJob/)
  assert.match(taskDialogSource, /version: requireTask\(task\)\.version/)
  assert.match(taskDialogSource, /validateAutomationJob\(task\.id\)/)
  assert.match(taskDialogSource, /triggerAutomationJob\(task\.id\)/)
  assert.match(taskDialogSource, /isManagedMonitorTask/)
  assert.match(taskDialogSource, /data-slot="automated-monitor-task-details"/)
  assert.match(taskDialogSource, /周报触发器和项目处理规则只读/)
  assert.match(taskDialogSource, /通用任务信息可在此调整/)
  assert.match(taskDialogSource, /isManagedMonitorTask[\s\S]*?name: payload\.name[\s\S]*?description: payload\.description[\s\S]*?enabled: payload\.enabled[\s\S]*?model_provider: payload\.model_provider[\s\S]*?model_id: payload\.model_id[\s\S]*?tag_ids: payload\.tag_ids/)
  assert.match(taskDialogSource, /!isCreateMode && form\.jobType === "weekly_report_project_summary_sync"/)
  assert.match(taskDialogSource, /createAutomationTag/)
  assert.doesNotMatch(taskDialogSource, /automated-task-(?:cron|timezone|catch-up|retries|retry-interval|timeout|retention)/)
  assert.match(taskDialogSource, /Field label="执行频率" htmlFor="automated-task-frequency"/)
  assert.match(taskDialogSource, /Field label="执行时间" htmlFor="automated-task-time"/)
  assert.match(taskDialogSource, /Field label="总结范围" htmlFor="automated-task-summary-scope"/)
  assert.match(taskDialogSource, /value="today">当天提交/)
  assert.match(taskDialogSource, /value="latest_commit_of_updating_projects">更新中项目的最新提交/)
  assert.match(taskDialogSource, /summary_scope: form\.summaryScope/)
  assert.match(taskDialogSource, /modelParameters: task\.model_parameters \?\? \{\}/)
  assert.match(taskDialogSource, /\.\.\.form\.modelParameters,[\s\S]*?summary_scope: form\.summaryScope/)
  assert.match(taskDialogSource, /buildAutomationCronExpression\(/)
  assert.match(taskDialogSource, /timezone: form\.timezone\.trim\(\)/)
  assert.match(taskDialogSource, /catch_up_policy: form\.catchUpPolicy/)
  assert.match(taskDialogSource, /retry_max_attempts: Number\(form\.retryMaxAttempts\)/)
  assert.match(taskDialogSource, /retry_interval_seconds: Number\(form\.retryIntervalSeconds\)/)
  assert.match(taskDialogSource, /timeout_seconds: Number\(form\.timeoutSeconds\)/)
  assert.match(taskDialogSource, /retention_days: Number\(form\.retentionDays\)/)
  assert.match(taskDialogSource, /automated-task-model/)
  assert.match(taskDialogSource, /getAutomationProviderOptions\(modelCatalog, form\.modelProvider\)/)
  assert.match(taskDialogSource, /getAutomationModelOptions\(modelCatalog, form\.modelProvider, form\.modelId\)/)
  assert.match(taskDialogSource, /resolveAutomationModelSelection\([\s\S]*?task\.model_provider,[\s\S]*?task\.model_id/)
  assert.match(taskDialogSource, /selectedProviderOption\?\.label \?\? form\.modelProvider/)
  assert.match(taskDialogSource, /selectedModelOption[\s\S]*?: form\.modelId/)
  assert.match(taskDialogSource, /disabled=\{!provider\.available\}/)
  assert.match(taskDialogSource, /disabled=\{!model\.available\}/)
  assert.match(taskDialogSource, /已回填历史模型配置，但该选项当前不可用/)
  assert.match(taskDialogSource, /hasUnavailableModelSelection/)
  assert.match(taskDialogSource, /保存更改/)
})

test("opens task run history as a read-only chat from the card body", () => {
  assert.match(bentoGridSource, /onSelect\?: \(\) => void/)
  assert.match(bentoGridSource, /aria-label=\{`查看任务对话：\$\{item\.title\}`\}/)
  assert.match(bentoGridSource, /onClick=\{item\.onSelect\}/)
  assert.match(automatedTasksSource, /onSelect: \(\) => openTaskConversation\(job\)/)
  assert.match(automatedTasksSource, /listAutomationRuns\(\{ jobId: task\.id, page: 1, size: 20 \}\)/)
  assert.match(automatedTasksSource, /getAutomationRun\(run\.id\)/)
  assert.match(automatedTasksSource, /hasPollableAutomationRuns\(conversationRuns\)/)
  assert.match(automatedTasksSource, /}, 3_000\)/)
  assert.match(automatedTasksSource, /conversationTask \? \(/)
  assert.match(automatedTasksSource, /<AutomatedTaskConversation/)
  assert.match(automatedTaskConversationSource, /data-slot="automated-task-conversation"/)
  assert.match(automatedTaskConversationSource, /data-slot="automated-task-run-conversation"/)
  assert.match(automatedTaskConversationSource, /data-slot="automated-task-conversation-pair"/)
  assert.doesNotMatch(automatedTaskConversationSource, /request_payload_sanitized/)
  assert.doesNotMatch(automatedTaskConversationSource, /脱敏输入/)
  assert.match(automatedTaskConversationSource, /task\.description/)
  assert.match(automatedTaskConversationSource, /当前项目：\$\{projectName\}/)
  assert.match(automatedTaskConversationSource, /resolveAutomationRunReply\(run, interaction\)/)
  assert.doesNotMatch(automatedTaskConversationSource, /response_payload_sanitized/)
  assert.doesNotMatch(automatedTaskConversationSource, /脱敏响应/)
  assert.match(automatedTaskConversationSource, /import \{ MessageBubble \}/)
  assert.match(automatedTaskConversationSource, /satisfies Message/)
  assert.match(automatedTaskConversationSource, /<MessageBubble message=\{requestMessage\} showActions=\{false\}/)
  assert.match(automatedTaskConversationSource, /<MessageBubble message=\{responseMessage\} showActions=\{false\}/)
  assert.doesNotMatch(automatedTaskConversationSource, /rounded-2xl rounded-tr-md|<Bot/)
  assert.match(messageBubbleSource, /showActions\?: boolean/)
  assert.match(messageBubbleSource, /showActions = true/)
  assert.match(messageBubbleSource, /\{showActions \? \(/)
  assert.match(automatedTaskConversationSource, /aria-label="返回自动任务列表"/)
})

test("keeps the automated task conversation header visible while scrolling", () => {
  const conversationHeader = automatedTaskConversationSource.match(
    /<header[\s\S]*?data-slot="automated-task-conversation-header"[\s\S]*?<\/header>/,
  )?.[0]

  assert.ok(conversationHeader, "expected a dedicated task conversation header")
  assert.match(conversationHeader, /sticky/)
  assert.match(conversationHeader, /top-0/)
  assert.doesNotMatch(conversationHeader, /sm:top-/)
  assert.match(conversationHeader, /z-10/)
  assert.match(conversationHeader, /h-10/)
  assert.match(conversationHeader, /flex-nowrap/)
  assert.match(conversationHeader, /rounded-full/)
  assert.match(conversationHeader, /ml-12/)
  assert.match(conversationHeader, /-mr-3/)
  assert.match(conversationHeader, /-mt-16/)
  assert.match(conversationHeader, /bg-zinc-100/)
  assert.match(conversationHeader, /text-stone-600/)
  assert.match(conversationHeader, /theme-dark:bg-zinc-800/)
  assert.match(conversationHeader, /theme-dark:text-zinc-300/)
  assert.match(conversationHeader, /sm:ml-8/)
  assert.match(conversationHeader, /sm:-mr-7/)
  assert.match(conversationHeader, /sm:mt-0/)
  assert.match(conversationHeader, /aria-label="返回自动任务列表"/)
  assert.match(conversationHeader, /最近 \{runs\.length\} 次运行/)
  assert.doesNotMatch(conversationHeader, /<p/)
})

test("opens the automated task conversation at the latest run and can return there", () => {
  assert.match(automatedTaskConversationSource, /const scrollToLatest = React\.useCallback/)
  assert.match(
    automatedTaskConversationSource,
    /scrollContainer\.scrollTo\(\{ top: scrollContainer\.scrollHeight, behavior \}\)/,
  )
  assert.match(
    automatedTaskConversationSource,
    /requestAnimationFrame\(\(\) => scrollToLatest\("auto"\)\)/,
  )
  assert.match(automatedTaskConversationSource, /new IntersectionObserver/)
  assert.match(automatedTaskConversationSource, /aria-label="回到最新运行"/)
  assert.match(
    automatedTaskConversationSource,
    /onClick=\{\(\) => scrollToLatest\("smooth"\)\}/,
  )
  assert.match(automatedTaskConversationSource, /<ArrowDown/)
})

test("keeps every task run time and detail action visible at the conversation footer", () => {
  const runConversationSource = automatedTaskConversationSource.match(
    /function RunConversation[\s\S]*?function ConversationPair/,
  )?.[0]

  assert.ok(runConversationSource, "expected task run conversation markup")
  assert.match(
    runConversationSource,
    /<div className="space-y-7">[\s\S]*?<\/div>\s*<div\s+data-slot="automated-task-run-metadata"/,
  )
  assert.match(runConversationSource, /<time dateTime=\{run\.started_at \?\? run\.scheduled_at\}/)
  assert.match(runConversationSource, /formatDateTime\(run\.started_at \?\? run\.scheduled_at\)/)
  assert.match(runConversationSource, /onClick=\{\(\) => onRunSelected\(run\.id\)\}/)
  assert.match(runConversationSource, />\s*运行详情\s*<\/Button>/)
  const metadataSource = runConversationSource.match(
    /<div\s+data-slot="automated-task-run-metadata"[\s\S]*?<\/div>\s*<\/section>/,
  )?.[0]
  assert.ok(metadataSource, "expected task run metadata footer")
  assert.doesNotMatch(metadataSource, /\bborder(?:-|\b)|\bshadow(?:-|\b)|\bbg-(?:white|zinc)/)
})

test("hides automated task creation until vertical task forms are available", () => {
  assert.doesNotMatch(automatedTasksSource, /data-slot="create-automated-task-button"/)
  assert.doesNotMatch(automatedTasksSource, /openCreateDialog/)
  assert.doesNotMatch(automatedTasksSource, /setTaskDialogMode\("create"\)/)
  assert.doesNotMatch(automatedTasksSource, /title="功能开发中"/)
  assert.doesNotMatch(automatedTasksSource, /AnimatedTooltip/)
  assert.doesNotMatch(automatedTasksSource, /openOnClick/)
})

test("loads full run audit and supports permission fallback and cancellation", () => {
  assert.match(automatedTasksSource, /getAutomationRun\(runId\)/)
  assert.match(automatedTasksSource, /getAutomationRun\(runId, "attempts"\)/)
  assert.match(automatedTasksSource, /automation:audit/)
  assert.match(runDetailSource, /data-slot="automation-run-detail-dialog"/)
  assert.match(runDetailSource, /AI 对话与调用审计/)
  assert.match(runDetailSource, /automationInteractionRepositoryFullName\(interaction\)/)
  assert.match(runDetailSource, /system_prompt_snapshot/)
  assert.match(runDetailSource, /request_payload_sanitized/)
  assert.match(runDetailSource, /cancelAutomationRun\(run\.id\)/)
  assert.match(runDetailSource, /取消请求已发送，正在等待 Worker 安全停止。/)
  assert.match(runDetailSource, /disabled=\{isCancelling \|\| cancelRequested\}/)
})

test("uses readable Chinese labels for project outcomes", () => {
  assert.match(runDetailSource, /<ProjectOutcomeTag outcome=\{projectOutcomeForDisplay\(project, run\.job_type\)\} \/>/)
  assert.match(runDetailSource, /label: "已完成评估并生成结果"/)
  assert.match(runDetailSource, /label: "项目已归档，已跳过处理"/)
  assert.match(runDetailSource, /label: "项目已归档，已后台处理"/)
  assert.match(runDetailSource, /label: "已落库待处理池中"/)
  assert.match(runDetailSource, /label: "无 GitHub 地址，已跳过处理"/)
  assert.match(runDetailSource, /label: "仓库读取完成，当天无新增 Commit"/)
  assert.match(runDetailSource, /backgroundClass: "bg-sky-100"/)
  assert.match(runDetailSource, /textClass: "text-\[#008AF5\]"/)
  assert.match(runDetailSource, /label: "处理不完整，未写入结果"/)
  assert.match(runDetailSource, /backgroundClass: "bg-orange-50"/)
  assert.match(runDetailSource, /textClass: "text-\[#EAA65D\]"/)
})

test("shows project warnings and incomplete project visibility hints", () => {
  assert.match(runDetailSource, /project\.outcome === "incomplete" && project\.warnings\.length > 0/)
  assert.match(runDetailSource, /<ProjectWarnings warnings=\{project\.warnings\} \/>/)
  assert.match(runDetailSource, /automation:audit/)
  assert.match(runDetailSource, /当前仅加载 \{run\.projects\.length\}\/\{run\.projects_total\} 个项目明细/)
  assert.match(runDetailSource, /repository_read_failed: "读取 GitHub 仓库失败"/)
})

test("polls and renders live automation run trace stages", () => {
  assert.match(automatedTasksSource, /getAutomationRunTrace\(runId\)/)
  assert.match(automatedTasksSource, /isActiveAutomationRun\(selectedRun\)/)
  assert.match(automatedTasksSource, /setInterval[\s\S]*?3_000/)
  assert.match(runDetailSource, /data-slot="automation-run-trace"/)
  assert.match(runDetailSource, /执行 Trace/)
  assert.match(runDetailSource, /repository_full_name/)
  assert.match(runDetailSource, /progress_current/)
  assert.match(runDetailSource, /实时更新/)
})

test("soft deletes jobs and keeps deleted task history readable", () => {
  assert.match(automatedTasksSource, /includeDeleted: true/)
  assert.match(automatedTasksSource, /job\.deleted/)
  assert.match(automatedTasksSource, /deletedCards/)
  assert.match(taskDialogSource, /deleteAutomationJob\(task\.id, task\.version\)/)
  assert.match(taskDialogSource, /确认软删除/)
  assert.match(taskDialogSource, /任务已于[\s\S]*?软删除/)
  assert.match(taskDialogSource, /历史运行和审计仍可查询/)
  assert.match(taskDialogSource, /isDeleted \? "关闭" : "取消"/)
})

test("connects tag create, update, disable, and delete management", () => {
  assert.match(automatedTasksSource, /<AutomationTagManagementDialog/)
  assert.match(automatedTasksSource, /<Tags[\s\S]*?标签管理/)
  assert.match(tagManagementSource, /data-slot="automation-tag-management-dialog"/)
  assert.match(tagManagementSource, /createAutomationTag/)
  assert.match(tagManagementSource, /updateAutomationTag/)
  assert.match(tagManagementSource, /deleteAutomationTag/)
  assert.match(tagManagementSource, /job_count/)
  assert.match(tagManagementSource, /确认删除/)
})

test("connects global run audit pagination and documented filters", () => {
  assert.match(automatedTasksSource, /<AutomationRunAuditDialog/)
  assert.match(automatedTasksSource, /<History[\s\S]*?运行审计/)
  assert.match(runAuditSource, /data-slot="automation-run-audit-dialog"/)
  assert.match(runAuditSource, /listAutomationRuns/)
  assert.match(runAuditSource, /status:/)
  assert.match(runAuditSource, /tagId:/)
  assert.match(runAuditSource, /modelProvider:/)
  assert.match(runAuditSource, /modelId:/)
  assert.match(runAuditSource, /startedAfter:/)
  assert.match(runAuditSource, /startedBefore:/)
  assert.match(runAuditSource, /setPage/)
  assert.match(runAuditSource, /run\.job_deleted/)
})

test("reuses the provided bento card component", () => {
  assert.match(bentoGridSource, /export interface BentoItem/)
  assert.match(bentoGridSource, /export type BentoItems = BentoItem\[\]/)
  assert.match(bentoGridSource, /data-slot="bento-grid"/)
  assert.match(bentoGridSource, /data-slot="bento-grid-item"/)
  assert.match(bentoGridSource, /hover:-translate-y-0\.5/)
  assert.match(bentoGridSource, /item\.hasPersistentHover/)
  assert.match(bentoGridSource, /grid-cols-\[repeat\(auto-fill,minmax\(min\(100%,20rem\),28rem\)\)\]/)
  assert.match(bentoGridSource, /justify-start/)
  assert.match(bentoGridSource, /min-h-40[\s\S]*?sm:min-h-32/)
  assert.match(bentoGridSource, /max-w-md/)
  assert.match(bentoGridSource, /flex min-h-32 items-start[\s\S]*?sm:min-h-24/)
  assert.match(bentoGridSource, /line-clamp-2/)
  assert.match(bentoGridSource, /flex-wrap[\s\S]*?sm:hidden[\s\S]*?item\.tags\.map/)
  assert.match(bentoGridSource, /hidden[\s\S]*?sm:flex[\s\S]*?item\.tags\.slice\(0, 3\)/)
  assert.doesNotMatch(bentoGridSource, /xl:grid-cols-2|md:grid-cols-3/)
  assert.match(automatedTasksSource, /meta: describeNextRun\(job\)/)
  assert.match(automatedTasksSource, /metaIcon: <Timer/)
  assert.match(automatedTasksSource, /暂无下次运行/)
  assert.match(automatedTasksSource, /下次运行：/)
  assert.match(automatedTasksSource, /今天[\s\S]*?明天[\s\S]*?昨天/)
  assert.doesNotMatch(automatedTasksSource, /describeAutomationSchedule/)
  assert.match(bentoGridSource, /metaIcon\?: ReactNode/)
  assert.match(bentoGridSource, /item\.metaIcon/)
  assert.match(bentoGridSource, /<h2[\s\S]*?data-slot="bento-grid-item-meta"[\s\S]*?<p className="mt-2 line-clamp-2/)
})

test("renders the conversation list without collapsible section groups", () => {
  assert.doesNotMatch(siderSource, /SidebarSection/)
  assert.doesNotMatch(siderSource, /CollapsibleTrigger/)
  assert.doesNotMatch(siderSource, /TASK_SECTION_TITLE/)
  assert.doesNotMatch(siderSource, /CONVERSATION_SECTION_TITLE/)
})

test("keeps the session list close to the new chat button", () => {
  const sessionList = siderSource.match(
    /<div\s+ref=\{sessionListRef\}[\s\S]*?>/,
  )?.[0]
  const topFade = siderSource.match(
    /<div\s+className="pointer-events-none absolute inset-x-0 top-0[^\"]*"/,
  )?.[0]

  assert.ok(sessionList, "expected the sider session list")
  assert.match(sessionList, /pt-4/)
  assert.match(sessionList, /pb-20/)
  assert.doesNotMatch(sessionList, /py-20/)
  assert.ok(topFade, "expected the session list top fade")
  assert.match(topFade, /h-4/)
  assert.doesNotMatch(topFade, /h-24/)
})

test("moves the desktop new chat action from floating controls into the sider", () => {
  const desktopControls = chatShellSource.match(
    /<div ref=\{sidebarControlsRef\}[\s\S]*?<\/div>/,
  )?.[0]

  assert.ok(desktopControls, "expected desktop sidebar controls")
  assert.doesNotMatch(desktopControls, /aria-label="New chat"/)
  assert.match(chatShellSource, /<Sider[\s\S]*?onNewSession=\{handleMobileNewSession\}/)
})

test("exposes the conversation list as a mobile drawer", () => {
  assert.match(chatShellSource, /aria-label="Open conversations"/)
  assert.match(chatShellSource, /data-slot="mobile-sider-backdrop"/)
  assert.match(chatShellSource, /setIsMobileSiderOpen\(true\)/)
  assert.match(siderSource, /isMobileOpen\?: boolean/)
  assert.match(siderSource, /aria-label="Close conversations"/)
  assert.match(siderSource, /invisible -translate-x-full pointer-events-none/)
  assert.match(siderSource, /w-\[min\(20rem,calc\(100vw-3rem\)\)\]/)
})
