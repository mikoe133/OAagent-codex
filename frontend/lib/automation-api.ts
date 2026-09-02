export type AutomationConfigurationStatus = "unverified" | "valid" | "invalid"

export type AutomationRunStatus =
  | "pending"
  | "claimed"
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "configuration_error"
  | "cancelled"
  | "skipped"
  | "timed_out"

export type AutomationTag = {
  id: number
  name: string
  color: string | null
  description: string
  enabled: boolean
  job_count?: number
}

export type AutomationModel = {
  model_id: string
  display_name: string
  enabled: boolean
  supports_structured_output?: boolean
  is_default?: boolean
}

export type AutomationModelProvider = {
  provider: string
  display_name: string
  models: AutomationModel[]
}

export type AutomationModelCatalog = {
  catalog_version: string
  providers: AutomationModelProvider[]
  cached_at?: string
  stale?: boolean
}

export type AutomationJobType = "github_project_progress_sync" | "weekly_report_project_summary_sync"
export type AutomationPromptProfileJobType = AutomationJobType

export type AutomationPromptProfile = {
  id: number
  job_type: AutomationPromptProfileJobType
  system_prompt: string
  required_capabilities: Array<"github_project_tracking" | "rwkvos_system_calls">
  prompt_version: string
  enabled: boolean
  version: number
  created_by: number | null
  updated_by: number | null
  created_at: string
  updated_at: string
}

export type AutomationPromptProfilePatchInput = {
  system_prompt: string
  enabled: boolean
  version: number
}

export type AutomationRecentRun = {
  id: string
  status: AutomationRunStatus
  scheduled_at: string
  error_code: string | null
  error_summary: string | null
}

export type AutomationSummaryScope =
  | "today"
  | "latest_commit_of_updating_projects"

export type AutomationJobParameters = {
  summary_scope?: AutomationSummaryScope
  reasoning_effort?: "low" | "medium" | "high" | "xhigh"
  max_output_tokens?: number
  project_scope?: "all_projects"
  include_archived_projects?: boolean
  write_archived_projects?: boolean
  minimum_confidence?: number
  on_ambiguous?: "no_write" | "record_and_continue"
  debounce_seconds?: number
}

export type AutomationManualRunInput = {
  project_id?: number
  summary_scope?: AutomationSummaryScope
}

export type AutomationJob = {
  id: number
  job_key: string
  job_type: AutomationJobType
  name: string
  display_name: string
  deleted: boolean
  deleted_at: string | null
  deleted_by: number | null
  description: string
  tags: AutomationTag[]
  enabled: boolean
  timezone: string
  schedule_type: "cron" | "event"
  trigger_type?: "schedule" | "event"
  trigger_config?: { resource: "weekly_report"; events: Array<"created" | "updated">; scope?: "job_owner" | "all_users" } | null
  cron_expression: string | null
  schedule_description: string
  catch_up_policy: "skip" | "latest"
  overlap_policy: "forbid"
  model_provider: string
  model_id: string
  model_parameters?: AutomationJobParameters
  model_catalog_version?: string | null
  configuration_status: AutomationConfigurationStatus
  configuration_error: string | null
  next_run_at: string | null
  last_run_at: string | null
  last_run_status: AutomationRunStatus | null
  retry_max_attempts?: number
  retry_interval_seconds?: number
  timeout_seconds?: number
  retention_days?: number
  version: number
  created_at: string
  updated_at: string
  recent_run?: AutomationRecentRun | null
}

export type AutomationJobCreateInput = {
  job_key: string
  job_type: AutomationJobType
  name: string
  description: string
  enabled: boolean
  timezone: string
  schedule_type: "cron" | "event"
  trigger_type?: "schedule" | "event"
  trigger_config?: { resource: "weekly_report"; events: Array<"created" | "updated">; scope?: "job_owner" | "all_users" } | null
  cron_expression: string | null
  catch_up_policy: "skip" | "latest"
  overlap_policy: "forbid"
  model_provider: string
  model_id: string
  model_parameters: AutomationJobParameters
  retry_max_attempts: number
  retry_interval_seconds: number
  timeout_seconds: number
  retention_days: number
  tag_ids: number[]
}

export type AutomationJobPatchInput = Partial<Omit<
  AutomationJobCreateInput,
  "job_key" | "job_type" | "schedule_type" | "overlap_policy"
>> & { version: number }

export type AutomationRun = {
  id: string
  root_run_id: string
  parent_run_id: string | null
  job_id: number
  job_key: string
  job_name: string
  job_display_name?: string
  job_deleted?: boolean
  job_type: string
  tags: Array<{ id: number; name: string; color: string | null }>
  trigger_source: "schedule" | "catch_up" | "manual" | "retry" | "event"
  scheduled_at: string
  available_at: string
  triggered_at: string
  status: AutomationRunStatus
  attempt: number
  model_provider: string
  model_id: string
  execution_parameters?: AutomationManualRunInput
  trigger_event_id?: string | null
  source_snapshot?: {
    event_id?: string
    source_report_id?: string
    source_version?: number
    weekly_num?: number
    content_hash?: string
    updated_at?: string
    scope?: Record<string, unknown>
  } | null
  model_catalog_version?: string | null
  cron_expression?: string | null
  timezone?: string
  retry_max_attempts?: number
  retry_interval_seconds?: number
  timeout_seconds?: number
  deadline_at: string
  started_at: string | null
  finished_at: string | null
  projects_total: number
  projects_succeeded: number
  projects_failed: number
  mutations_applied: boolean
  retry_recommended: boolean
  error_code: string | null
  error_summary: string | null
  cancel_requested_at: string | null
  duration_ms: number | null
  ai_interaction_count?: number
  projects?: AutomationRunProject[]
  weekly_report_pending_item_count?: number
  weekly_report_pending_items?: AutomationWeeklyReportPendingItem[]
  ai_interactions?: AutomationAiInteraction[]
  attempts?: AutomationRun[]
}

export type AutomationRunProject = {
  id: number
  run_id: string
  project_id: number
  project_name: string
  status_before: string | null
  status_after: string | null
  outcome: string
  repository_count: number
  commit_count: number
  summary_date: string | null
  source_digest: string | null
  generated_summary: string | null
  ai_confidence: number | null
  ai_note: string | null
  warnings: Array<Record<string, unknown>>
  mutations_applied: boolean
  started_at?: string | null
  finished_at?: string | null
  duration_ms: number | null
  created_at: string
  updated_at: string
}

export type AutomationWeeklyReportPendingItem = {
  id: number
  run_id: string
  trigger_event_id: string
  source_report_id: string
  source_version: number
  weekly_num: number
  owner_user_id: number | null
  segment_key: string
  segment_order: number
  content_digest: string
  original_content: string | null
  ai_summary: string | null
  ai_reason: string | null
  reason_code: string
  classification_source: string
  referenced_project_id: number | null
  candidate_project_ids: number[]
  ai_confidence: number | null
  status: string
  resolution_type: string | null
  resolved_project_id: number | null
  resolution_batch_id: string | null
  resolution_note: string | null
  resolved_by: number | null
  resolved_at: string | null
  sync_status: string
  sync_error: string | null
  reprocessed_run_id: string | null
  content_purged_at: string | null
  created_at: string
  updated_at: string
}

export type AutomationAiInteraction = {
  id: number
  run_id: string
  run_project_id: number
  interaction_key: string
  provider: string
  model: string
  model_catalog_version: string | null
  prompt_version: string | null
  fallback_used: boolean
  upstream_request_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  status: "succeeded" | "failed" | "fallback"
  error_code: string | null
  error_summary: string | null
  purged_at: string | null
  created_at: string
  system_prompt_snapshot?: string | null
  request_payload_sanitized?: unknown
  response_payload_sanitized?: unknown
  final_summary?: string | null
  limitations?: Array<Record<string, unknown>>
}

export type AutomationRunTraceStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "fallback"
  | "failed"
  | "cancelled"

export type AutomationRunTraceEvent = {
  id: number
  event_key: string
  sequence: number
  phase: string
  status: AutomationRunTraceStatus
  title: string
  message: string | null
  progress_current: number | null
  progress_total: number | null
  project_id: number | null
  repository_full_name: string | null
  metadata_sanitized: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  occurred_at: string
  updated_at: string
}

export type AutomationPagination<T> = {
  total: number
  items: T[]
}

export type AutomationJobFilters = {
  page?: number
  size?: number
  name?: string
  enabled?: boolean
  tagId?: number
  configurationStatus?: AutomationConfigurationStatus
  includeDeleted?: boolean
}

export type AutomationRunFilters = {
  page?: number
  size?: number
  jobId?: number
  tagId?: number
  projectId?: number
  activeOnly?: boolean
  includeFullScope?: boolean
  status?: AutomationRunStatus
  triggerSource?: AutomationRun["trigger_source"]
  modelProvider?: string
  modelId?: string
  startedAfter?: string
  startedBefore?: string
}

export type AutomationTagPatchInput = {
  name?: string
  color?: string | null
  description?: string
  enabled?: boolean
}

type AutomationEnvelope<T> = {
  code?: number
  message?: string
  data?: T
  success?: boolean
  error?: string
}

const MODEL_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000
const inFlightGetRequests = new Map<string, Promise<unknown>>()
let modelCatalogCache: {
  value: AutomationModelCatalog
  expiresAt: number
} | null = null

export class AutomationApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string | null,
  ) {
    super(message)
    this.name = "AutomationApiError"
  }
}

export async function listAutomationJobs(
  filters: AutomationJobFilters = {},
): Promise<AutomationPagination<AutomationJob>> {
  const query = new URLSearchParams({
    page: String(filters.page ?? 1),
    size: String(filters.size ?? 100),
    sort: "-updated_at",
  })
  if (filters.name) query.set("name", filters.name)
  if (filters.enabled !== undefined) query.set("enabled", String(filters.enabled))
  if (filters.tagId !== undefined) query.set("tag_id", String(filters.tagId))
  if (filters.configurationStatus) query.set("configuration_status", filters.configurationStatus)
  if (filters.includeDeleted) query.set("include_deleted", "true")
  return automationRequest<AutomationPagination<AutomationJob>>(`/jobs?${query.toString()}`)
}

export function getAutomationJob(
  jobId: number,
  options: { includeDeleted?: boolean } = {},
): Promise<AutomationJob> {
  const query = options.includeDeleted ? "?include_deleted=true" : ""
  return automationRequest<AutomationJob>(`/jobs/${jobId}${query}`)
}

export function createAutomationJob(
  input: AutomationJobCreateInput,
): Promise<AutomationJob> {
  return automationRequest<AutomationJob>("/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateAutomationJob(
  jobId: number,
  input: AutomationJobPatchInput,
): Promise<AutomationJob> {
  return automationRequest<AutomationJob>(`/jobs/${jobId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export function deleteAutomationJob(
  jobId: number,
  version: number,
): Promise<AutomationJob> {
  return automationRequest<AutomationJob>(
    `/jobs/${jobId}?version=${encodeURIComponent(version)}`,
    { method: "DELETE" },
  )
}

export function validateAutomationJob(jobId: number): Promise<AutomationJob> {
  return automationRequest<AutomationJob>(`/jobs/${jobId}/validate`, {
    method: "POST",
  })
}

export function triggerAutomationJob(
  jobId: number,
  input?: AutomationManualRunInput,
): Promise<{ run_id: string; status: AutomationRunStatus; reused: boolean }> {
  return automationRequest(`/jobs/${jobId}/runs`, {
    method: "POST",
    ...(input ? { body: JSON.stringify(input) } : {}),
  })
}

export async function listAutomationTags(
  filters: { name?: string; enabled?: boolean } = {},
): Promise<AutomationPagination<AutomationTag>> {
  const query = new URLSearchParams({ page: "1", size: "100" })
  if (filters.name) query.set("name", filters.name)
  if (filters.enabled !== undefined) query.set("enabled", String(filters.enabled))
  return automationRequest<AutomationPagination<AutomationTag>>(`/tags?${query.toString()}`)
}

export function createAutomationTag(input: {
  name: string
  color?: string | null
  description?: string
}): Promise<AutomationTag> {
  return automationRequest<AutomationTag>("/tags", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      color: input.color ?? null,
      description: input.description ?? "",
      enabled: true,
    }),
  })
}

export function updateAutomationTag(
  tagId: number,
  input: AutomationTagPatchInput,
): Promise<AutomationTag> {
  return automationRequest<AutomationTag>(`/tags/${tagId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export function deleteAutomationTag(tagId: number): Promise<{ id: number }> {
  return automationRequest<{ id: number }>(`/tags/${tagId}`, {
    method: "DELETE",
  })
}

export function getAutomationModelCatalog(): Promise<AutomationModelCatalog> {
  if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now()) {
    return Promise.resolve(modelCatalogCache.value)
  }
  return automationRequest<AutomationModelCatalog>("/models").then((catalog) => {
    modelCatalogCache = {
      value: catalog,
      expiresAt: Date.now() + MODEL_CATALOG_CACHE_TTL_MS,
    }
    return catalog
  })
}

export function getAutomationPromptProfile(
  jobType: AutomationPromptProfileJobType,
): Promise<AutomationPromptProfile> {
  return automationRequest<AutomationPromptProfile>(`/prompt-profiles/${jobType}`)
}

export function updateAutomationPromptProfile(
  jobType: AutomationPromptProfileJobType,
  input: AutomationPromptProfilePatchInput,
): Promise<AutomationPromptProfile> {
  return automationRequest<AutomationPromptProfile>(`/prompt-profiles/${jobType}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export function listAutomationRuns(
  filters: AutomationRunFilters | number = {},
): Promise<AutomationPagination<AutomationRun>> {
  const normalizedFilters = typeof filters === "number" ? { jobId: filters } : filters
  const query = new URLSearchParams({
    page: String(normalizedFilters.page ?? 1),
    size: String(normalizedFilters.size ?? 20),
    sort: "-scheduled_at",
  })
  if (normalizedFilters.jobId !== undefined) query.set("job_id", String(normalizedFilters.jobId))
  if (normalizedFilters.tagId !== undefined) query.set("tag_id", String(normalizedFilters.tagId))
  if (normalizedFilters.projectId !== undefined) query.set("project_id", String(normalizedFilters.projectId))
  if (normalizedFilters.activeOnly !== undefined) query.set("active_only", String(normalizedFilters.activeOnly))
  if (normalizedFilters.includeFullScope !== undefined) query.set("include_full_scope", String(normalizedFilters.includeFullScope))
  if (normalizedFilters.status) query.set("status", normalizedFilters.status)
  if (normalizedFilters.triggerSource) query.set("trigger_source", normalizedFilters.triggerSource)
  if (normalizedFilters.modelProvider) query.set("model_provider", normalizedFilters.modelProvider)
  if (normalizedFilters.modelId) query.set("model_id", normalizedFilters.modelId)
  if (normalizedFilters.startedAfter) query.set("started_after", normalizedFilters.startedAfter)
  if (normalizedFilters.startedBefore) query.set("started_before", normalizedFilters.startedBefore)
  return automationRequest<AutomationPagination<AutomationRun>>(`/runs?${query.toString()}`)
}

export function getAutomationRun(
  runId: string,
  include: "attempts" | "projects,ai_interactions,attempts,weekly_report_pending_items" = "projects,ai_interactions,attempts,weekly_report_pending_items",
): Promise<AutomationRun> {
  return automationRequest<AutomationRun>(
    `/runs/${encodeURIComponent(runId)}?include=${encodeURIComponent(include)}`,
  )
}

export function getAutomationRunTrace(
  runId: string,
): Promise<AutomationPagination<AutomationRunTraceEvent>> {
  return automationRequest<AutomationPagination<AutomationRunTraceEvent>>(
    `/runs/${encodeURIComponent(runId)}/trace-events`,
  )
}

export function cancelAutomationRun(runId: string): Promise<AutomationRun> {
  return automationRequest<AutomationRun>(
    `/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  )
}

function automationRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase()
  if (method !== "GET") {
    return executeAutomationRequest<T>(path, init)
  }

  const requestKey = `/api/automation${path}`
  const inFlightRequest = inFlightGetRequests.get(requestKey) as Promise<T> | undefined
  if (inFlightRequest) {
    return inFlightRequest
  }

  const request = executeAutomationRequest<T>(path, init).finally(() => {
    if (inFlightGetRequests.get(requestKey) === request) {
      inFlightGetRequests.delete(requestKey)
    }
  })
  inFlightGetRequests.set(requestKey, request)
  return request
}

async function executeAutomationRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`/api/automation${path}`, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  })
  const text = await response.text()
  let payload: AutomationEnvelope<T> | null = null
  try {
    payload = text ? JSON.parse(text) as AutomationEnvelope<T> : null
  } catch {
    payload = null
  }
  if (!response.ok || payload?.success === false || payload?.data === undefined) {
    const errorData = payload?.data as { error_code?: unknown } | undefined
    const errorCode = typeof errorData?.error_code === "string"
      ? errorData.error_code
      : null
    throw new AutomationApiError(
      payload?.message || payload?.error || `自动任务请求失败（HTTP ${response.status}）`,
      response.status,
      errorCode,
    )
  }
  return payload.data
}
