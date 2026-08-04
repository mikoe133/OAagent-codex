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

export type AutomationPromptProfileJobType = "github_project_progress_sync"

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

export type AutomationJob = {
  id: number
  job_key: string
  job_type: "github_project_progress_sync"
  name: string
  display_name: string
  deleted: boolean
  deleted_at: string | null
  deleted_by: number | null
  description: string
  tags: AutomationTag[]
  enabled: boolean
  timezone: string
  schedule_type: "cron"
  cron_expression: string
  schedule_description: string
  catch_up_policy: "skip" | "latest"
  overlap_policy: "forbid"
  model_provider: string
  model_id: string
  model_parameters?: Record<string, never>
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
  job_type: "github_project_progress_sync"
  name: string
  description: string
  enabled: boolean
  timezone: string
  schedule_type: "cron"
  cron_expression: string
  catch_up_policy: "skip" | "latest"
  overlap_policy: "forbid"
  model_provider: string
  model_id: string
  model_parameters: Record<string, never>
  retry_max_attempts: number
  retry_interval_seconds: number
  timeout_seconds: number
  retention_days: number
  tag_ids: number[]
}

export type AutomationJobPatchInput = Omit<
  AutomationJobCreateInput,
  "job_key" | "job_type" | "schedule_type" | "overlap_policy"
> & { version: number }

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
  trigger_source: "schedule" | "catch_up" | "manual" | "retry"
  scheduled_at: string
  available_at: string
  triggered_at: string
  status: AutomationRunStatus
  attempt: number
  model_provider: string
  model_id: string
  model_catalog_version?: string | null
  cron_expression?: string
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
  ai_interactions?: AutomationAiInteraction[]
  attempts?: AutomationRun[]
}

export type AutomationRunProject = {
  id: number
  project_id: number
  project_name: string
  status_before: string | null
  status_after: string | null
  outcome: string
  repository_count: number
  commit_count: number
  summary_date: string | null
  generated_summary: string | null
  ai_confidence: number | null
  ai_note: string | null
  warnings: Array<Record<string, unknown>>
  mutations_applied: boolean
  started_at?: string | null
  finished_at?: string | null
  duration_ms: number | null
}

export type AutomationAiInteraction = {
  id: number
  run_project_id: number
  provider: string
  model: string
  prompt_version: string | null
  fallback_used: boolean
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  status: "succeeded" | "failed" | "fallback"
  error_code: string | null
  error_summary: string | null
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
): Promise<{ run_id: string; status: AutomationRunStatus }> {
  return automationRequest(`/jobs/${jobId}/runs`, { method: "POST" })
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
  include: "attempts" | "projects,ai_interactions,attempts" = "projects,ai_interactions,attempts",
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
