import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import type { AppConfig } from "../config/config.js";
import {
  getDefaultModel,
  resolveRequestedModel,
  resolveRequestedProvider,
  ROUTER_MODEL_CATALOG,
  type ModelProviderId,
  type RouterModelId,
} from "../config/modelCatalog.js";
import {
  createCodexClient,
  startOrResumeThread,
} from "../infrastructure/codex/codexClient.js";
import {
  type AgentRuntimeContext,
  buildRuntimeContext,
  buildTaskPrompt,
  collectExecutedCommands,
  redactSecrets,
} from "./runCodexAgent.js";
import type {
  AgentSession,
  SessionStore,
} from "../infrastructure/persistence/sessionStore.js";
import { resolveOpenApiContract } from "../infrastructure/oa/openApiContract.js";
import {
  routeOpenApiRequestWithFallback,
  createOpenApiSemanticRouter,
  type OpenApiRouteResult,
} from "../infrastructure/oa/openApiRouter.js";
import { mergeOpenApiIndexes } from "../infrastructure/oa/openApiIndex.js";
import { resolveKnowledgeBaseContracts } from "../infrastructure/knowledgebase/knowledgeBaseContract.js";
import {
  beginKnowledgeBaseSourceTurn,
  finishKnowledgeBaseSourceTurn,
  type KnowledgeBaseSource,
} from "../infrastructure/knowledgebase/knowledgeBaseSources.js";
import {
  beginOaTurn,
  finishOaTurn,
  resolveOaQueryPolicy,
} from "../infrastructure/oa/oaQueryPolicy.js";
import { resolveTaskReasoningEffort } from "./taskReasoningPolicy.js";
import type {
  ChatLatencyStage,
  ChatLatencyTrace,
} from "../infrastructure/observability/chatLatency.js";

export type SendMessageInput = {
  sessionId: string;
  message: string;
  provider?: string | null;
  model?: string | null;
  developerMode?: boolean;
  routerModel?: RouterModelId | null;
  oaApiToken?: string | null;
  oaUserId?: string | null;
  latency?: ChatLatencyTrace;
};

export type SendMessageResult = {
  sessionId: string;
  threadId: string;
  provider: ModelProviderId;
  model: string;
  finalResponse: string;
  executedCommands: string[];
  knowledgeSources: KnowledgeBaseSource[];
  summary: string | null;
};

export type AgentProgressEvent = {
  type: "progress";
  sessionId: string;
  itemId?: string;
  status?: "in_progress" | "completed" | "failed";
  message: string;
  detail?: unknown;
  toolType?: string;
  durationMs?: number;
};

type RequestRoutingProgressEvent = AgentProgressEvent & {
  itemId: "request-routing";
  status: "in_progress" | "completed" | "failed";
};

type RequestRoutingProgressEmit = (
  event: RequestRoutingProgressEvent,
) => void | Promise<void>;

type LatencyStageProgress = (
  stage: ChatLatencyStage,
  status: "in_progress" | "completed" | "failed",
  durationMs?: number,
  messageOverride?: string,
) => Promise<void>;

export type AgentStreamEvent =
  | {
      type: "run.queued";
      sessionId: string;
    }
  | {
      type: "run.started";
      sessionId: string;
    }
  | {
      type: "thread.started";
      sessionId: string;
      threadId: string;
    }
  | {
      type: "turn.started";
      sessionId: string;
    }
  | AgentProgressEvent
  | {
      type: "message.delta";
      sessionId: string;
      itemId: string;
      delta: string;
      text: string;
    }
  | {
      type: "tool.started";
      sessionId: string;
      itemId: string;
      toolType: "command_execution" | "mcp_tool_call" | "web_search";
      name: string;
      input?: unknown;
      status?: string;
    }
  | {
      type: "tool.updated";
      sessionId: string;
      itemId: string;
      toolType: "command_execution" | "mcp_tool_call";
      status: string;
      outputDelta?: string;
    }
  | {
      type: "tool.completed";
      sessionId: string;
      itemId: string;
      toolType: "command_execution" | "mcp_tool_call" | "web_search";
      name: string;
      status?: string;
      exitCode?: number;
      outputDelta?: string;
      result?: unknown;
      error?: string;
      durationMs?: number;
    }
  | {
      type: "run.completed";
      sessionId: string;
      result: SendMessageResult;
      usage: Usage | null;
    }
  | {
      type: "run.failed";
      sessionId: string;
      error: string;
    };

export type AgentStreamEmit = (event: AgentStreamEvent) => void | Promise<void>;

export async function runRequestRoutingWithProgress<T>(
  sessionId: string,
  emit: RequestRoutingProgressEmit,
  route: () => Promise<T>,
  options: {
    includeDuration?: boolean;
    now?: () => number;
  } = {},
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const startedAt = options.includeDuration ? now() : null;
  await emit({
    type: "progress",
    sessionId,
    itemId: "request-routing",
    status: "in_progress",
    message: "正在理解请求并选择合适的数据源…",
  });

  let result: T;
  try {
    result = await route();
  } catch (error) {
    await emit({
      type: "progress",
      sessionId,
      itemId: "request-routing",
      status: "failed",
      message: "数据能力准备失败。",
      ...(startedAt === null
        ? {}
        : { durationMs: Math.max(0, Math.round(now() - startedAt)) }),
    });
    throw error;
  }

  await emit({
    type: "progress",
    sessionId,
    itemId: "request-routing",
    status: "completed",
    message: "已准备好相关数据能力，正在生成回答…",
    ...(startedAt === null
      ? {}
      : { durationMs: Math.max(0, Math.round(now() - startedAt)) }),
  });
  return result;
}

export type StreamRecoveryDecision =
  | {
      kind: "existing_response";
      response: string;
    }
  | {
      kind: "tool_fallback";
      response: string;
    };

export class AgentService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.enqueue(
      input.sessionId,
      () => this.runMessage(input),
      input.latency,
    );
  }

  async streamMessage(
    input: SendMessageInput,
    emit: AgentStreamEmit,
    signal?: AbortSignal,
  ): Promise<void> {
    await emit({ type: "run.queued", sessionId: input.sessionId });
    return this.enqueue(
      input.sessionId,
      () => this.runMessageStream(input, emit, signal),
      input.latency,
    );
  }

  private async runMessage(input: SendMessageInput): Promise<SendMessageResult> {
    input.latency?.mark("routing_started");
    const finishRouting = input.latency?.startStage("request_routing");
    const session = await measureLatencyStage(
      input.latency,
      "session_prepare",
      () => this.prepareSession(input),
    );
    const resolvedRun = await resolveRunConfig(
      this.config,
      input.provider,
      input.model,
      input.message,
      session.summary,
      undefined,
      input.latency,
      input.routerModel,
    );
    finishRouting?.();
    input.latency?.mark("routing_completed");
    const runConfig = resolvedRun.config;
    const runtimeContext = {
      ...this.getRuntimeContext(input.sessionId),
      openApiCandidates: resolvedRun.openApiCandidates,
      selectedApiCatalogs: resolvedRun.selectedApiCatalogs,
      knowledgeBaseWriteContractAvailable:
        resolvedRun.knowledgeBaseWriteContractAvailable,
      oaQueryPolicy: resolvedRun.oaQueryPolicy,
    };
    const codex = createCodexClient(runConfig, input.sessionId);
    const thread = startOrResumeThread(
      codex,
      runConfig,
      session.threadId,
      runConfig.model,
      resolvedRun.reasoningEffort,
    );
    const prompt = buildPromptForSession(
      runConfig,
      session,
      input.message,
      runtimeContext,
    );
    beginOaTurn(input.sessionId, resolvedRun.oaQueryPolicy);
    beginKnowledgeBaseSourceTurn(input.sessionId);
    let knowledgeSources: KnowledgeBaseSource[] = [];
    input.latency?.markOnce("codex_invoked");
    const turn = await (async () => {
      try {
        return await thread.run(prompt);
      } finally {
        finishOaTurn(input.sessionId);
        knowledgeSources = finishKnowledgeBaseSourceTurn(input.sessionId);
      }
    })();
    input.latency?.markOnce("first_message");
    input.latency?.mark("turn_completed");
    input.latency?.mark("codex_stream_closed");

    if (!turn.finalResponse.trim() || !hasTerminalAgentResponse(turn.items)) {
      const itemTypes = turn.items.map((item) => item.type).join(", ") || "无";
      throw new Error(
        `agent 未返回最终回答(turn 已结束或最后一次工具调用后没有 agent_message)。过程 items: ${itemTypes}。`,
      );
    }

    if (!thread.id) {
      throw new Error("agent turn 已完成,但 SDK 未返回 thread id。");
    }

    await measureLatencyStage(input.latency, "persistence", () =>
      this.sessions.updateThreadId(input.sessionId, thread.id!),
    );
    const summary = buildNextSummary(session.summary, input.message, turn.finalResponse);
    await measureLatencyStage(input.latency, "persistence", () =>
      this.sessions.updateSummary(input.sessionId, summary),
    );

    const secrets = this.getSecrets(runtimeContext.sessionOaApiToken);
    return {
      sessionId: input.sessionId,
      threadId: thread.id,
      provider: runConfig.modelProvider,
      model: runConfig.model,
      finalResponse: redactSecrets(turn.finalResponse, secrets),
      executedCommands: collectExecutedCommands(turn.items).map((command) =>
        redactSecrets(command, secrets),
      ),
      knowledgeSources,
      summary,
    };
  }

  private async runMessageStream(
    input: SendMessageInput,
    emit: AgentStreamEmit,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    await emit({ type: "run.started", sessionId: input.sessionId });

    const stageProgress = input.developerMode
      ? createLatencyStageProgress(input.sessionId, emit, input.routerModel)
      : undefined;

    input.latency?.mark("routing_started");
    const finishRouting = input.latency?.startStage("request_routing");
    const { session, resolvedRun } = await runRequestRoutingWithProgress(
      input.sessionId,
      emit,
      async () => {
        const session = await measureLatencyStage(
          input.latency,
          "session_prepare",
          () => this.prepareSession(input),
          stageProgress,
        );
        const resolvedRun = await resolveRunConfig(
          this.config,
          input.provider,
          input.model,
          input.message,
          session.summary,
          signal,
          input.latency,
          input.routerModel,
          stageProgress,
        );
        return { session, resolvedRun };
      },
      { includeDuration: input.developerMode === true },
    );
    finishRouting?.();
    input.latency?.mark("routing_completed");
    const runConfig = resolvedRun.config;
    const runtimeContext = {
      ...this.getRuntimeContext(input.sessionId),
      openApiCandidates: resolvedRun.openApiCandidates,
      selectedApiCatalogs: resolvedRun.selectedApiCatalogs,
      knowledgeBaseWriteContractAvailable:
        resolvedRun.knowledgeBaseWriteContractAvailable,
      oaQueryPolicy: resolvedRun.oaQueryPolicy,
    };
    const codex = createCodexClient(runConfig, input.sessionId);
    const thread = startOrResumeThread(
      codex,
      runConfig,
      session.threadId,
      runConfig.model,
      resolvedRun.reasoningEffort,
    );
    const prompt = buildPromptForSession(
      runConfig,
      session,
      input.message,
      runtimeContext,
    );
    const state = createStreamState(input.developerMode === true);
    const secrets = this.getSecrets(runtimeContext.sessionOaApiToken);
    const recoverStream = async (): Promise<boolean> => {
      const recovery = resolveStreamRecovery(
        state.finalResponse,
        state.items,
        secrets,
        state.activeToolIds,
      );
      if (!recovery) {
        return false;
      }

      state.finalResponse = recovery.response;
      state.turnFailure = null;
      if (recovery.kind === "tool_fallback") {
        await emit({
          type: "message.delta",
          sessionId: input.sessionId,
          itemId: `fallback-${Date.now()}`,
          delta: recovery.response,
          text: recovery.response,
        });
      }
      return true;
    };

    beginOaTurn(input.sessionId, resolvedRun.oaQueryPolicy);
    beginKnowledgeBaseSourceTurn(input.sessionId);
    let knowledgeSources: KnowledgeBaseSource[] = [];
    const runStreamedTurn = async (turnPrompt: string): Promise<void> => {
      input.latency?.markOnce("codex_invoked");
      if (stageProgress && state.modelStartupStartedAt === undefined) {
        state.modelStartupStartedAt = performance.now();
        await stageProgress("codex_startup", "in_progress");
      }
      const { events } = await thread.runStreamed(turnPrompt, { signal });
      for await (const event of events) {
        throwIfAborted(signal);
        await this.emitCodexEvent(
          input.sessionId,
          event,
          state,
          secrets,
          emit,
          input.latency,
          stageProgress,
        );
      }
      input.latency?.mark("codex_stream_closed");
    };
    try {
      try {
        await runStreamedTurn(prompt);
        if (
          !state.turnFailure &&
          !hasTerminalAgentResponse(state.items, state.activeToolIds)
        ) {
          state.finalResponse = "";
          state.activeToolIds.clear();
          await runStreamedTurn(
            buildIncompleteTurnContinuationPrompt(input.message),
          );
        }
      } catch (error) {
        if (!(await recoverStream())) {
          throw resolveStreamFailure(error, state.turnFailure, secrets);
        }
      }
    } finally {
      finishOaTurn(input.sessionId);
      knowledgeSources = finishKnowledgeBaseSourceTurn(input.sessionId);
    }

    if (state.turnFailure) {
      const turnFailure = state.turnFailure;
      if (!(await recoverStream())) {
        throw new Error(turnFailure);
      }
    }

    if (
      !state.finalResponse.trim() ||
      !hasTerminalAgentResponse(state.items, state.activeToolIds)
    ) {
      const itemTypes = state.items.map((item) => item.type).join(", ") || "无";
      throw new Error(
        `agent 未返回最终回答(turn 已结束或最后一次工具调用后没有 agent_message)。过程 items: ${itemTypes}。`,
      );
    }

    if (!thread.id) {
      throw new Error("agent turn 已完成,但 SDK 未返回 thread id。");
    }

    await measureLatencyStage(input.latency, "persistence", () =>
      this.sessions.updateThreadId(input.sessionId, thread.id!),
    );
    const summary = buildNextSummary(
      session.summary,
      input.message,
      state.finalResponse,
    );
    await measureLatencyStage(input.latency, "persistence", () =>
      this.sessions.updateSummary(input.sessionId, summary),
    );

    const result: SendMessageResult = {
      sessionId: input.sessionId,
      threadId: thread.id,
      provider: runConfig.modelProvider,
      model: runConfig.model,
      finalResponse: state.finalResponse,
      executedCommands: collectExecutedCommands(state.items).map((command) =>
        redactSecrets(command, secrets),
      ),
      knowledgeSources,
      summary,
    };

    await emit({
      type: "run.completed",
      sessionId: input.sessionId,
      result,
      usage: state.usage,
    });
  }

  private async emitCodexEvent(
    sessionId: string,
    event: ThreadEvent,
    state: AgentStreamState,
    secrets: string[],
    emit: AgentStreamEmit,
    latency?: ChatLatencyTrace,
    stageProgress?: LatencyStageProgress,
  ): Promise<void> {
    if (event.type === "thread.started") {
      await measureLatencyStage(latency, "persistence", () =>
        this.sessions.updateThreadId(sessionId, event.thread_id),
      );
      await emit({
        type: "thread.started",
        sessionId,
        threadId: event.thread_id,
      });
      return;
    }

    if (event.type === "turn.started") {
      latency?.markOnce("turn_started");
      if (stageProgress && state.modelStartupStartedAt !== undefined) {
        await stageProgress(
          "codex_startup",
          "completed",
          elapsedMilliseconds(state.modelStartupStartedAt),
        );
        state.modelStartupStartedAt = undefined;
        state.modelInferenceStartedAt = performance.now();
        await stageProgress("model_inference", "in_progress");
      }
      await emit({ type: "turn.started", sessionId });
      return;
    }

    if (event.type === "turn.completed") {
      state.usage = event.usage;
      latency?.mark("turn_completed");
      return;
    }

    if (event.type === "turn.failed") {
      state.turnFailure = redactSecrets(event.error.message, secrets);
      return;
    }

    if (event.type === "error") {
      state.turnFailure = redactSecrets(event.message, secrets);
      return;
    }

    await this.emitItemEvent(
      sessionId,
      event.type,
      event.item,
      state,
      secrets,
      emit,
      latency,
      stageProgress,
    );
  }

  private async emitItemEvent(
    sessionId: string,
    eventType: "item.started" | "item.updated" | "item.completed",
    item: ThreadItem,
    state: AgentStreamState,
    secrets: string[],
    emit: AgentStreamEmit,
    latency?: ChatLatencyTrace,
    stageProgress?: LatencyStageProgress,
  ): Promise<void> {
    let durationMs: number | undefined;
    if (isToolThreadItem(item)) {
      if (eventType === "item.completed") {
        state.activeToolIds.delete(item.id);
        latency?.toolCompleted(item.id);
        const startedAt = state.toolStartedAt.get(item.id);
        if (startedAt !== undefined) {
          durationMs = Math.max(0, Math.round(performance.now() - startedAt));
          state.toolStartedAt.delete(item.id);
        }
      } else {
        state.activeToolIds.add(item.id);
        latency?.toolStarted(item.id, item.type);
        if (state.captureStepDurations && !state.toolStartedAt.has(item.id)) {
          state.toolStartedAt.set(item.id, performance.now());
        }
      }
    }

    if (eventType === "item.completed") {
      state.items.push(item);
    }

    if (item.type === "agent_message") {
      const text = redactSecrets(item.text, secrets);
      const previous = state.messageTexts.get(item.id) ?? "";
      const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
      state.messageTexts.set(item.id, text);
      if (eventType === "item.completed") {
        state.finalResponse = text;
      }
      if (delta) {
        latency?.markOnce("first_message");
        if (stageProgress && state.modelInferenceStartedAt !== undefined) {
          await stageProgress(
            "model_inference",
            "completed",
            elapsedMilliseconds(state.modelInferenceStartedAt),
          );
          state.modelInferenceStartedAt = undefined;
        }
        await emit({
          type: "message.delta",
          sessionId,
          itemId: item.id,
          delta,
          text,
        });
      }
      return;
    }

    if (item.type === "command_execution") {
      const command = redactSecrets(item.command, secrets);
      const output = redactSecrets(item.aggregated_output || "", secrets);
      const previousOutput = state.commandOutputs.get(item.id) ?? "";
      const outputDelta = output.startsWith(previousOutput)
        ? output.slice(previousOutput.length)
        : output;
      state.commandOutputs.set(item.id, output);

      if (eventType === "item.started") {
        await emit({
          type: "tool.started",
          sessionId,
          itemId: item.id,
          toolType: "command_execution",
          name: command,
          status: item.status,
        });
        return;
      }

      if (eventType === "item.completed") {
        await emit({
          type: "tool.completed",
          sessionId,
          itemId: item.id,
          toolType: "command_execution",
          name: command,
          status: item.status,
          exitCode: item.exit_code,
          outputDelta: outputDelta || undefined,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        return;
      }

      await emit({
        type: "tool.updated",
        sessionId,
        itemId: item.id,
        toolType: "command_execution",
        status: item.status,
        outputDelta: outputDelta || undefined,
      });
      return;
    }

    if (item.type === "mcp_tool_call") {
      if (eventType === "item.started") {
        await emit({
          type: "tool.started",
          sessionId,
          itemId: item.id,
          toolType: "mcp_tool_call",
          name: `${item.server}.${item.tool}`,
          input: redactValue(item.arguments, secrets),
          status: item.status,
        });
        return;
      }

      if (eventType === "item.completed") {
        await emit({
          type: "tool.completed",
          sessionId,
          itemId: item.id,
          toolType: "mcp_tool_call",
          name: `${item.server}.${item.tool}`,
          status: item.status,
          result: redactValue(item.result, secrets),
          error: item.error
            ? redactSecrets(item.error.message, secrets)
            : undefined,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        return;
      }

      await emit({
        type: "tool.updated",
        sessionId,
        itemId: item.id,
        toolType: "mcp_tool_call",
        status: item.status,
      });
      return;
    }

    if (item.type === "web_search") {
      const query = redactSecrets(item.query, secrets);
      if (eventType === "item.completed") {
        await emit({
          type: "tool.completed",
          sessionId,
          itemId: item.id,
          toolType: "web_search",
          name: "web_search",
          result: { query },
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        return;
      }

      await emit({
        type: "tool.started",
        sessionId,
        itemId: item.id,
        toolType: "web_search",
        name: "web_search",
        input: { query },
      });
      return;
    }

    if (item.type === "todo_list") {
      await emit({
        type: "progress",
        sessionId,
        message: "agent 更新了任务进度。",
        detail: redactValue(item.items, secrets),
      });
      return;
    }

    if (item.type === "file_change") {
      await emit({
        type: "progress",
        sessionId,
        message: `agent ${item.status === "completed" ? "完成" : "未能完成"}文件变更。`,
        detail: redactValue(item.changes, secrets),
      });
      return;
    }

    if (item.type === "error") {
      await emit({
        type: "progress",
        sessionId,
        message: redactSecrets(item.message, secrets),
      });
    }
  }

  private async enqueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
    latency?: ChatLatencyTrace,
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const finishQueueWait = latency?.startStage("queue_wait");
    const current = previous.catch(() => undefined).then(() => {
      finishQueueWait?.();
      return operation();
    });
    const queueTail = current.catch(() => undefined).finally(() => {
      if (this.queues.get(sessionId) === queueTail) {
        this.queues.delete(sessionId);
      }
    });
    this.queues.set(sessionId, queueTail);
    return current;
  }

  private async prepareSession(input: SendMessageInput): Promise<AgentSession> {
    const session = await this.sessions.getOrCreate(input.sessionId);
    if (input.oaApiToken) {
      await this.sessions.bindOaToken(
        input.sessionId,
        input.oaApiToken,
        undefined,
        input.oaUserId,
      );
    }
    return session;
  }

  private getRuntimeContext(sessionId: string): AgentRuntimeContext & {
    sessionOaApiToken: string | null;
  } {
    const sessionOaApiToken = this.sessions.getOaToken(sessionId);
    const sessionOaUserId = this.sessions.getOaUserId(sessionId);
    return {
      sessionId,
      hasSessionOaApiToken: Boolean(sessionOaApiToken),
      hasSessionOaUserId: Boolean(sessionOaUserId),
      sessionOaApiToken,
    };
  }

  private getSecrets(sessionOaApiToken: string | null = null): string[] {
    return [
      ...Object.values(this.config.modelProviders).map((provider) => provider.apiKey),
      sessionOaApiToken ?? "",
      this.config.oaApiToolToken,
      this.config.knowledgeBaseApiToken ?? "",
    ];
  }
}

type AgentStreamState = {
  items: ThreadItem[];
  activeToolIds: Set<string>;
  finalResponse: string;
  usage: Usage | null;
  turnFailure: string | null;
  messageTexts: Map<string, string>;
  commandOutputs: Map<string, string>;
  captureStepDurations: boolean;
  toolStartedAt: Map<string, number>;
  modelStartupStartedAt?: number;
  modelInferenceStartedAt?: number;
};

function createStreamState(captureStepDurations = false): AgentStreamState {
  return {
    items: [],
    activeToolIds: new Set(),
    finalResponse: "",
    usage: null,
    turnFailure: null,
    messageTexts: new Map(),
    commandOutputs: new Map(),
    captureStepDurations,
    toolStartedAt: new Map(),
  };
}

function buildPromptForSession(
  config: AppConfig,
  session: AgentSession,
  message: string,
  runtimeContext: AgentRuntimeContext,
): string {
  if (!session.threadId) {
    return buildTaskPrompt(config, message, runtimeContext);
  }

  return [
    "<runtime_context>",
    buildRuntimeContext(config, runtimeContext),
    "</runtime_context>",
    "",
    "<conversation_memory>",
    session.summary || "无",
    "</conversation_memory>",
    "",
    "<user_task>",
    message,
    "</user_task>",
  ].join("\n");
}

export function buildIncompleteTurnContinuationPrompt(message: string): string {
  return [
    "<continuation_task>",
    "上一轮在工具调用后结束，但用户请求尚未形成完整最终回答。",
    "先根据原始请求重新拆分独立子问题，并逐项核对当前 thread 中的已有证据，包括工具结果和业务结论。",
    "只处理尚未完成、尚未确认未找到或尚未说明阻塞原因的子问题；不要重复已经完成的查询。",
    "按缺失证据自主选择下一步，可以复用已有 OA responseId、知识库结果和其他上下文，不预设固定工具顺序或调用次数。",
    "工具调用成功本身不代表子问题已回答；必须把工具证据转化为用户需要的业务结论。",
    "不得重复已成功的相同请求，不得只说明下一步计划。",
    "完成后必须在最后一次工具调用之后输出一条覆盖全部子问题的最终业务回答。",
    `原始用户请求: ${message}`,
    "</continuation_task>",
  ].join("\n");
}

async function resolveRunConfig(
  config: AppConfig,
  requestedProvider: string | null | undefined,
  requestedModel: string | null | undefined,
  task: string,
  conversationMemory: string | null,
  signal?: AbortSignal,
  latency?: ChatLatencyTrace,
  routerModel?: RouterModelId | null,
  stageProgress?: LatencyStageProgress,
) {
  const modelProvider = resolveRequestedProvider(requestedProvider, config.modelProvider);
  const fallbackModel =
    modelProvider === config.modelProvider ? config.model : getDefaultModel(modelProvider);
  const model = resolveRequestedModel(modelProvider, requestedModel, fallbackModel);
  const [openapi, knowledgeBase] = await measureLatencyStage(
    latency,
    "contracts",
    () => Promise.all([
      resolveOpenApiContract(config),
      resolveKnowledgeBaseContracts(config),
    ]),
    stageProgress,
  );
  const runConfig = { ...config, modelProvider, model, openapiPath: openapi.path };
  const routingIndex = mergeOpenApiIndexes([
    openapi.index,
    knowledgeBase.read.index,
    ...(knowledgeBase.write ? [knowledgeBase.write.index] : []),
  ]);
  const primaryRouterConfig = resolveRouterConfig(runConfig, routerModel);
  const fallbackRouterModel = ROUTER_MODEL_CATALOG[0];
  const fallbackRouterConfig = resolveRouterConfig(
    runConfig,
    fallbackRouterModel,
  );
  const fallbackRouter =
    primaryRouterConfig.model === fallbackRouterConfig.model
      ? undefined
      : createOpenApiSemanticRouter(fallbackRouterConfig);
  const route = await measureLatencyStage(
    latency,
    "semantic_route",
    () => routeOpenApiRequestWithFallback(
      primaryRouterConfig,
      routingIndex,
      { task, conversationMemory, signal },
      createOpenApiSemanticRouter(primaryRouterConfig),
      fallbackRouter,
    ),
    stageProgress,
    formatSemanticRouteTraceMessage,
  );
  return {
    config: runConfig,
    openApiCandidates: route.candidates,
    selectedApiCatalogs: route.catalogs,
    knowledgeBaseWriteContractAvailable: knowledgeBase.write !== null,
    reasoningEffort: resolveTaskReasoningEffort(task),
    oaQueryPolicy: resolveOaQueryPolicy(task),
  };
}

export function resolveRouterConfig(
  config: AppConfig,
  routerModel?: RouterModelId | null,
): AppConfig {
  if (!routerModel) {
    return config;
  }
  return { ...config, modelProvider: "openrouter", model: routerModel };
}

async function measureLatencyStage<T>(
  latency: ChatLatencyTrace | undefined,
  stage: ChatLatencyStage,
  operation: () => Promise<T>,
  stageProgress?: LatencyStageProgress,
  formatCompletionMessage?: (result: T) => string,
): Promise<T> {
  const finish = latency?.startStage(stage);
  const startedAt = stageProgress ? performance.now() : undefined;
  if (stageProgress) {
    await stageProgress(stage, "in_progress");
  }
  try {
    const result = await operation();
    if (stageProgress && startedAt !== undefined) {
      await stageProgress(
        stage,
        "completed",
        elapsedMilliseconds(startedAt),
        formatCompletionMessage?.(result),
      );
    }
    return result;
  } catch (error) {
    if (stageProgress && startedAt !== undefined) {
      await stageProgress(stage, "failed", elapsedMilliseconds(startedAt));
    }
    throw error;
  } finally {
    finish?.();
  }
}

function createLatencyStageProgress(
  sessionId: string,
  emit: AgentStreamEmit,
  routerModel?: RouterModelId | null,
): LatencyStageProgress {
  const stageNames: Partial<Record<ChatLatencyStage, string>> = {
    session_prepare: "准备会话上下文",
    contracts: "准备 OA 与知识库接口契约",
    semantic_route: routerModel
      ? `使用 ${routerModel} 分析请求`
      : "分析请求并选择业务接口",
    codex_startup: "启动正式回答模型",
    model_inference: "等待模型生成首段回复",
  };

  return async (stage, status, durationMs, messageOverride) => {
    const message = messageOverride ?? stageNames[stage];
    if (!message) {
      return;
    }
    await emit({
      type: "progress",
      sessionId,
      itemId: `latency-${stage.replaceAll("_", "-")}`,
      toolType: stage,
      status,
      message,
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  };
}

export function formatSemanticRouteTraceMessage(
  route: OpenApiRouteResult,
): string {
  const catalogs = route.catalogs.map(formatRouteCatalog).join("、");
  if (route.diagnostics.strategy === "fallback") {
    return `路由模型失败，已启用安全降级；原因：${route.diagnostics.failureReason}；最终接口域：${catalogs}`;
  }
  if (route.diagnostics.usedFallbackModel) {
    if (!route.diagnostics.primaryFailureReason) {
      return `备用语义模型先完成路由，已取消较慢的首选模型；最终接口域：${catalogs}`;
    }
    return `首选路由模型失败（${route.diagnostics.primaryFailureReason ?? "返回结果无效"}），已切换备用语义模型；最终接口域：${catalogs}`;
  }
  return `路由模型选择完成；最终接口域：${catalogs}`;
}

function formatRouteCatalog(catalog: OpenApiRouteResult["catalogs"][number]): string {
  if (catalog === "oa") {
    return "OA";
  }
  if (catalog === "knowledge_base_read") {
    return "知识库读取";
  }
  if (catalog === "rwkv_knowledge") {
    return "RWKV 知识";
  }
  return "知识库写入";
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function buildNextSummary(
  previousSummary: string | null,
  message: string,
  finalResponse: string,
): string {
  const entries = [
    previousSummary,
    `用户: ${compactText(message, 500)}`,
    `助手: ${compactText(finalResponse, 700)}`,
  ].filter((entry): entry is string => Boolean(entry));

  return compactText(entries.join("\n"), 3000);
}

export function resolveStreamRecovery(
  finalResponse: string,
  items: ThreadItem[],
  secrets: string[],
  activeToolIds: ReadonlySet<string> = new Set(),
): StreamRecoveryDecision | null {
  if (
    finalResponse.trim() &&
    hasTerminalAgentResponse(items, activeToolIds)
  ) {
    return {
      kind: "existing_response",
      response: finalResponse,
    };
  }

  const fallbackResponse = buildFallbackResponseFromToolResult(items, secrets);
  return fallbackResponse
    ? { kind: "tool_fallback", response: fallbackResponse }
    : null;
}

export function hasTerminalAgentResponse(
  items: ThreadItem[],
  activeToolIds: ReadonlySet<string> = new Set(),
): boolean {
  if (activeToolIds.size > 0) {
    return false;
  }
  let lastAgentMessageIndex = -1;
  let lastToolIndex = -1;
  items.forEach((item, index) => {
    if (item.type === "agent_message") {
      lastAgentMessageIndex = index;
    } else if (
      item.type === "command_execution" ||
      item.type === "mcp_tool_call" ||
      item.type === "file_change" ||
      item.type === "web_search"
    ) {
      lastToolIndex = index;
    }
  });
  return lastAgentMessageIndex >= 0 && lastAgentMessageIndex > lastToolIndex;
}

function isToolThreadItem(item: ThreadItem): boolean {
  return item.type === "command_execution" ||
    item.type === "mcp_tool_call" ||
    item.type === "file_change" ||
    item.type === "web_search";
}

export function resolveStreamFailure(
  caughtError: unknown,
  turnFailure: string | null,
  secrets: string[],
): Error {
  const caughtMessage =
    caughtError instanceof Error ? caughtError.message : String(caughtError);
  const message = turnFailure?.trim() || caughtMessage;
  if (message.startsWith("Failed to parse item:")) {
    return new Error(
      "Codex SDK 无法解析 JSONL 事件流。工具输出可能包含被 Node 24 误判为换行的 Unicode 分隔符，请重试；若持续发生，请改用 Node 22 运行服务。",
    );
  }
  if (/(?:429|too many requests|exceeded retry limit)/i.test(message)) {
    const requestId = message.match(/request id:\s*([^\s,]+)/i)?.[1];
    return new Error(
      [
        "回答模型服务暂时限流（429），不是 OA 或知识库接口失败。",
        "服务已按 Retry-After 或指数退避完成有限重试，但上游仍未恢复；请稍后重试，或切换模型提供商。",
        requestId ? `上游 request id: ${requestId}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    );
  }
  if (/(?:usage limit|credit balance|insufficient[_ ]quota|spend limit|quota exhausted)/i.test(message)) {
    const requestId = message.match(/request id:\s*([^\s,]+)/i)?.[1];
    return new Error(
      [
        "回答模型提供商的使用额度或消费上限已达到。",
        "这不是 OA 或知识库接口失败，也不是继续重试能解决的问题；请切换模型/提供商，或为当前账户充值、提高额度。",
        requestId ? `上游 request id: ${requestId}` : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" "),
    );
  }
  return new Error(redactSecrets(message, secrets));
}

function buildFallbackResponseFromToolResult(
  items: ThreadItem[],
  secrets: string[],
): string | null {
  for (const item of [...items].reverse()) {
    if (
      item.type !== "command_execution" ||
      item.exit_code !== 0 ||
      !item.command.includes("callOaApi.mjs")
    ) {
      continue;
    }

    const result = parseOaApiToolOutput(item.aggregated_output);
    if (!result) {
      continue;
    }

    const method = (stringValue(result.method) ?? "").toUpperCase();
    if (
      !isMutatingMethod(method) ||
      !isConfirmedMutationCommand(item.command) ||
      !isSuccessfulOaApiResult(result) ||
      !stringValue(result.operationId) ||
      !stringValue(result.path)
    ) {
      continue;
    }

    return redactSecrets(formatOaApiFallbackResponse(result), secrets);
  }

  return null;
}

type ParsedOaApiToolResult = {
  ok?: unknown;
  status?: unknown;
  operationId?: unknown;
  method?: unknown;
  path?: unknown;
  data?: unknown;
  error?: unknown;
};

function parseOaApiToolOutput(output: string): ParsedOaApiToolResult | null {
  const trimmed = output.trim();
  const parsed = parseJsonObject(trimmed) ?? parseJsonObject(extractJson(trimmed));
  if (!parsed || !("operationId" in parsed || "error" in parsed)) {
    return null;
  }
  return parsed as ParsedOaApiToolResult;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractJson(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return value.slice(start, end + 1);
}

function formatOaApiFallbackResponse(result: ParsedOaApiToolResult): string {
  const payload = toRecord(result.data);
  const data = toRecord(payload?.data);
  const facts = summarizeOaApiData(data);
  return [
    "已成功执行修改操作。",
    facts ? `结果:${facts}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function summarizeOaApiData(data: Record<string, unknown> | null): string | null {
  if (!data) {
    return null;
  }

  const facts: string[] = [];
  const weeklyNum = numberValue(data.weekly_num);
  const userId = numberValue(data.user_id);
  const content = stringValue(data.content);
  const id = numberValue(data.id);

  if (weeklyNum !== null) {
    facts.push(`系统 weekly_num=${weeklyNum}`);
  }
  if (content) {
    facts.push(`content 已更新为 \`${compactText(content, 120)}\``);
  }
  if (id !== null) {
    facts.push(`id=${id}`);
  }
  if (userId !== null) {
    facts.push(`user_id=${userId}`);
  }

  return facts.length > 0 ? facts.join(", ") : null;
}

function isMutatingMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isConfirmedMutationCommand(command: string): boolean {
  return /(?:^|\s)--confirmed(?:=|\s+)(?:true|1|yes)(?=\s|$)/i.test(command);
}

function isSuccessfulOaApiResult(result: ParsedOaApiToolResult): boolean {
  const payload = toRecord(result.data);
  const status = numberValue(result.status);
  return (
    booleanValue(result.ok) ??
    booleanValue(payload?.success) ??
    (status !== null ? status >= 200 && status < 300 : false)
  );
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return normalized.slice(0, maxLength - 1).trimEnd() + "...";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("客户端已断开,agent 流式请求已取消。");
  }
}

function redactValue(value: unknown, secrets: string[], depth = 0): unknown {
  if (depth > 6) {
    return "[TRUNCATED]";
  }
  if (typeof value === "string") {
    return redactSecrets(value, secrets);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactValue(item, secrets, depth + 1));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(
      entries.map(([key, item]) => [key, redactValue(item, secrets, depth + 1)]),
    );
  }
  return String(value);
}
