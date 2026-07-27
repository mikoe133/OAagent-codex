import type { ProjectStatus } from "../../domain/projectProgress.js";

const PROJECT_PAGE_SIZE = 100;
const OA_REQUEST_TIMEOUT_MS = 15_000;

export type OaProject = {
  id: number;
  projectName: string;
  status: ProjectStatus;
  githubUrls: string[];
  version?: number;
};

export interface ProjectProgressOaReader {
  listProjects(): Promise<OaProject[]>;
  getProject(projectId: number): Promise<OaProject>;
}

export type OaCommitSummary = {
  id: number;
  projectId: number;
  summaryDate: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
  version?: number;
};

export type CommitSummaryCreateInput = {
  projectId: number;
  summaryDate: string;
  summary: string;
  aiConfidence: number;
  aiNote: string;
};

export type CommitSummaryUpdateInput = Omit<
  CommitSummaryCreateInput,
  "projectId" | "summaryDate"
>;

export interface ProjectProgressOaWriter extends ProjectProgressOaReader {
  updateProjectStatus(
    projectId: number,
    status: Exclude<ProjectStatus, "archived">,
  ): Promise<void>;
  listCommitSummaries(
    projectId: number,
    summaryDate: string,
  ): Promise<OaCommitSummary[]>;
  getCommitSummary(summaryId: number): Promise<OaCommitSummary>;
  createCommitSummary(input: CommitSummaryCreateInput): Promise<OaCommitSummary>;
  updateCommitSummary(
    summaryId: number,
    input: CommitSummaryUpdateInput,
  ): Promise<OaCommitSummary>;
}

export type ProjectProgressOaClientConfig = {
  baseUrl: string;
  alias: string;
  token: string;
  tokenHeader: string;
  tokenPrefix: string;
};

type OaFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class OaContractError extends Error {
  override name = "OaContractError";
}

export class OaRequestError extends Error {
  override name = "OaRequestError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ProjectProgressOaClient implements ProjectProgressOaWriter {
  constructor(
    private readonly config: ProjectProgressOaClientConfig,
    private readonly fetchImpl: OaFetch = fetch,
  ) {}

  async listProjects(): Promise<OaProject[]> {
    const projects: OaProject[] = [];
    for (let page = 1; ; page += 1) {
      const payload = await this.request("/projects/list-by-project", {
        page,
        size: PROJECT_PAGE_SIZE,
      });
      const pagination = decodePagination(payload, decodeProject);
      projects.push(...pagination.items);
      if (pagination.items.length === 0 || projects.length >= pagination.total) {
        return projects;
      }
    }
  }

  async getProject(projectId: number): Promise<OaProject> {
    const payload = await this.request("/projects/project", { project_id: projectId });
    const envelope = decodeEnvelope(payload);
    const candidate = isRecord(envelope.data) && "item" in envelope.data
      ? envelope.data.item
      : envelope.data;
    return decodeProject(candidate);
  }

  async updateProjectStatus(
    projectId: number,
    status: Exclude<ProjectStatus, "archived">,
  ): Promise<void> {
    await this.request(
      "/projects/project",
      { project_id: projectId },
      { method: "PUT", body: { status } },
    );
  }

  async listCommitSummaries(
    projectId: number,
    summaryDate: string,
  ): Promise<OaCommitSummary[]> {
    const payload = await this.request("/projects/github-commit-summaries", {
      project_id: projectId,
      summary_date: summaryDate,
      page: 1,
      size: 2,
    });
    return decodePagination(payload, decodeCommitSummary).items;
  }

  async getCommitSummary(summaryId: number): Promise<OaCommitSummary> {
    const payload = await this.request("/projects/github-commit-summary", {
      summary_id: summaryId,
    });
    return decodeCommitSummary(decodeEnvelope(payload).data);
  }

  async createCommitSummary(
    input: CommitSummaryCreateInput,
  ): Promise<OaCommitSummary> {
    const payload = await this.request(
      "/projects/github-commit-summary",
      {},
      {
        method: "POST",
        body: {
          project_id: input.projectId,
          summary_date: input.summaryDate,
          summary: input.summary,
          ai_confidence: input.aiConfidence,
          ai_note: input.aiNote,
        },
      },
    );
    return this.decodeOrReadCommitSummary(payload);
  }

  async updateCommitSummary(
    summaryId: number,
    input: CommitSummaryUpdateInput,
  ): Promise<OaCommitSummary> {
    const payload = await this.request(
      "/projects/github-commit-summary",
      { summary_id: summaryId },
      {
        method: "PUT",
        body: {
          summary: input.summary,
          ai_confidence: input.aiConfidence,
          ai_note: input.aiNote,
        },
      },
    );
    return this.decodeOrReadCommitSummary(payload);
  }

  private async decodeOrReadCommitSummary(payload: unknown): Promise<OaCommitSummary> {
    const data = decodeEnvelope(payload).data;
    try {
      return decodeCommitSummary(data);
    } catch (error) {
      if (
        error instanceof OaContractError &&
        isRecord(data) &&
        Number.isInteger(data.id) &&
        (data.id as number) > 0
      ) {
        return this.getCommitSummary(data.id as number);
      }
      throw error;
    }
  }

  private async request(
    path: string,
    query: Record<string, string | number>,
    options: {
      method?: "GET" | "POST" | "PUT";
      body?: Record<string, unknown>;
    } = {},
  ): Promise<unknown> {
    const url = new URL(path, ensureTrailingSlash(this.config.baseUrl));
    for (const [name, value] of Object.entries({ ...query, alias: this.config.alias })) {
      url.searchParams.set(name, String(value));
    }
    const response = await this.fetchImpl(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        [this.config.tokenHeader]: formatToken(this.config.tokenPrefix, this.config.token),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(OA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new OaRequestError(`OA 请求失败:HTTP ${response.status}`, response.status);
    }
    try {
      return await response.json();
    } catch {
      throw new OaContractError("OA 响应不是合法 JSON。");
    }
  }
}

function decodePagination<T>(
  payload: unknown,
  decodeItem: (value: unknown) => T,
): { total: number; items: T[] } {
  const envelope = decodeEnvelope(payload);
  if (!isRecord(envelope.data)) {
    throw new OaContractError("OA 分页响应缺少 data 对象。");
  }
  const { total, items } = envelope.data;
  if (!Number.isInteger(total) || (total as number) < 0 || !Array.isArray(items)) {
    throw new OaContractError("OA 分页响应的 total/items 类型无效。");
  }
  return { total: total as number, items: items.map(decodeItem) };
}

function decodeEnvelope(payload: unknown): { data: unknown } {
  if (!isRecord(payload) || !("data" in payload)) {
    throw new OaContractError("OA 响应缺少 data envelope。");
  }
  if (payload.success === false) {
    throw new OaContractError("OA 响应 success=false。");
  }
  return { data: payload.data };
}

function decodeProject(value: unknown): OaProject {
  if (!isRecord(value)) {
    throw new OaContractError("OA 项目不是对象。");
  }
  const status = value.status;
  if (!isProjectStatus(status)) {
    throw new OaContractError(`OA 项目 status 无效:${String(status)}`);
  }
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    throw new OaContractError("OA 项目 id 无效。");
  }
  if (typeof value.project_name !== "string") {
    throw new OaContractError("OA 项目 project_name 无效。");
  }
  if (!Array.isArray(value.github_urls) || !value.github_urls.every((url) => typeof url === "string")) {
    throw new OaContractError("OA 项目 github_urls 无效。");
  }
  if (value.version !== undefined && !Number.isInteger(value.version)) {
    throw new OaContractError("OA 项目 version 无效。");
  }
  return {
    id: value.id as number,
    projectName: value.project_name,
    status,
    githubUrls: value.github_urls,
    ...(typeof value.version === "number" ? { version: value.version } : {}),
  };
}

function decodeCommitSummary(value: unknown): OaCommitSummary {
  if (!isRecord(value)) {
    throw new OaContractError("OA commit summary 不是对象。");
  }
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    throw new OaContractError("OA commit summary id 无效。");
  }
  if (!Number.isInteger(value.project_id) || (value.project_id as number) < 1) {
    throw new OaContractError("OA commit summary project_id 无效。");
  }
  if (typeof value.summary_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.summary_date)) {
    throw new OaContractError("OA commit summary summary_date 无效。");
  }
  if (
    typeof value.summary !== "string" ||
    !Number.isInteger(value.ai_confidence) ||
    (value.ai_confidence as number) < 0 ||
    (value.ai_confidence as number) > 100 ||
    typeof value.ai_note !== "string"
  ) {
    throw new OaContractError("OA commit summary 内容字段无效。");
  }
  if (value.version !== undefined && !Number.isInteger(value.version)) {
    throw new OaContractError("OA commit summary version 无效。");
  }
  return {
    id: value.id as number,
    projectId: value.project_id as number,
    summaryDate: value.summary_date,
    summary: value.summary,
    aiConfidence: value.ai_confidence as number,
    aiNote: value.ai_note,
    ...(typeof value.version === "number" ? { version: value.version } : {}),
  };
}

function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === "updating" || value === "maintenance" || value === "archived";
}

function formatToken(prefix: string, token: string): string {
  if (!prefix) {
    return token;
  }
  return /[=\s]$/.test(prefix) ? `${prefix}${token}` : `${prefix} ${token}`;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
