import type { ThreadEvent, ThreadItem, Usage } from "@openai/codex-sdk";
import type { AppConfig } from "../config/config.js";
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

export type SendMessageInput = {
  sessionId: string;
  message: string;
  oaApiToken?: string | null;
};

export type SendMessageResult = {
  sessionId: string;
  threadId: string;
  finalResponse: string;
  executedCommands: string[];
  summary: string | null;
};

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
  | {
      type: "progress";
      sessionId: string;
      message: string;
      detail?: unknown;
    }
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

export class AgentService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    return this.enqueue(input.sessionId, () => this.runMessage(input));
  }

  async streamMessage(
    input: SendMessageInput,
    emit: AgentStreamEmit,
    signal?: AbortSignal,
  ): Promise<void> {
    await emit({ type: "run.queued", sessionId: input.sessionId });
    return this.enqueue(input.sessionId, () =>
      this.runMessageStream(input, emit, signal),
    );
  }

  private async runMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const session = await this.prepareSession(input);
    const runtimeContext = this.getRuntimeContext(input.sessionId);
    const codex = createCodexClient(this.config, input.sessionId);
    const thread = startOrResumeThread(codex, this.config, session.threadId);
    const prompt = buildPromptForSession(
      this.config,
      session,
      input.message,
      runtimeContext,
    );
    const turn = await thread.run(prompt);

    if (!turn.finalResponse.trim()) {
      const itemTypes = turn.items.map((item) => item.type).join(", ") || "无";
      throw new Error(
        `agent 未返回最终回答(turn 已结束但没有 agent_message)。过程 items: ${itemTypes}。`,
      );
    }

    if (!thread.id) {
      throw new Error("agent turn 已完成,但 SDK 未返回 thread id。");
    }

    await this.sessions.updateThreadId(input.sessionId, thread.id);
    const summary = buildNextSummary(session.summary, input.message, turn.finalResponse);
    await this.sessions.updateSummary(input.sessionId, summary);

    const secrets = this.getSecrets(runtimeContext.sessionOaApiToken);
    return {
      sessionId: input.sessionId,
      threadId: thread.id,
      finalResponse: redactSecrets(turn.finalResponse, secrets),
      executedCommands: collectExecutedCommands(turn.items).map((command) =>
        redactSecrets(command, secrets),
      ),
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

    const session = await this.prepareSession(input);
    const runtimeContext = this.getRuntimeContext(input.sessionId);
    const codex = createCodexClient(this.config, input.sessionId);
    const thread = startOrResumeThread(codex, this.config, session.threadId);
    const prompt = buildPromptForSession(
      this.config,
      session,
      input.message,
      runtimeContext,
    );
    const { events } = await thread.runStreamed(prompt, { signal });
    const state = createStreamState();
    const secrets = this.getSecrets(runtimeContext.sessionOaApiToken);

    for await (const event of events) {
      throwIfAborted(signal);
      await this.emitCodexEvent(input.sessionId, event, state, secrets, emit);
    }

    if (state.turnFailure) {
      throw new Error(state.turnFailure);
    }

    if (!state.finalResponse.trim()) {
      const itemTypes = state.items.map((item) => item.type).join(", ") || "无";
      throw new Error(
        `agent 未返回最终回答(turn 已结束但没有 agent_message)。过程 items: ${itemTypes}。`,
      );
    }

    if (!thread.id) {
      throw new Error("agent turn 已完成,但 SDK 未返回 thread id。");
    }

    await this.sessions.updateThreadId(input.sessionId, thread.id);
    const summary = buildNextSummary(
      session.summary,
      input.message,
      state.finalResponse,
    );
    await this.sessions.updateSummary(input.sessionId, summary);

    const result: SendMessageResult = {
      sessionId: input.sessionId,
      threadId: thread.id,
      finalResponse: state.finalResponse,
      executedCommands: collectExecutedCommands(state.items).map((command) =>
        redactSecrets(command, secrets),
      ),
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
  ): Promise<void> {
    if (event.type === "thread.started") {
      await emit({
        type: "thread.started",
        sessionId,
        threadId: event.thread_id,
      });
      return;
    }

    if (event.type === "turn.started") {
      await emit({ type: "turn.started", sessionId });
      return;
    }

    if (event.type === "turn.completed") {
      state.usage = event.usage;
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

    await this.emitItemEvent(sessionId, event.type, event.item, state, secrets, emit);
  }

  private async emitItemEvent(
    sessionId: string,
    eventType: "item.started" | "item.updated" | "item.completed",
    item: ThreadItem,
    state: AgentStreamState,
    secrets: string[],
    emit: AgentStreamEmit,
  ): Promise<void> {
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
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const queueTail = current.finally(() => {
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
      await this.sessions.bindOaToken(input.sessionId, input.oaApiToken);
    }
    return session;
  }

  private getRuntimeContext(sessionId: string): AgentRuntimeContext & {
    sessionOaApiToken: string | null;
  } {
    const sessionOaApiToken = this.sessions.getOaToken(sessionId);
    return {
      sessionId,
      hasSessionOaApiToken: Boolean(sessionOaApiToken),
      sessionOaApiToken,
    };
  }

  private getSecrets(sessionOaApiToken: string | null = null): string[] {
    return [
      this.config.openrouterApiKey,
      this.config.oaApiToken ?? "",
      sessionOaApiToken ?? "",
      this.config.oaApiToolToken,
    ];
  }
}

type AgentStreamState = {
  items: ThreadItem[];
  finalResponse: string;
  usage: Usage | null;
  turnFailure: string | null;
  messageTexts: Map<string, string>;
  commandOutputs: Map<string, string>;
};

function createStreamState(): AgentStreamState {
  return {
    items: [],
    finalResponse: "",
    usage: null,
    turnFailure: null,
    messageTexts: new Map(),
    commandOutputs: new Map(),
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
