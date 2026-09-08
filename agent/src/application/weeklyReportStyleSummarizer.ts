import { createHash } from "node:crypto";
import path from "node:path";
import type { ProjectProgressConfig } from "../config/projectProgressConfig.js";
import type { ProjectProgressAiInteraction } from "./projectProgressSummarizer.js";
import { runWeeklyReportAgent, type WeeklyReportAgentRunner } from "./weeklyReportAgentSummarizer.js";

import { WEEKLY_REPORT_STYLE_PROMPT, WEEKLY_REPORT_STYLE_PROMPT_VERSION } from "../domain/weeklyReportStyle.js";
export { WEEKLY_REPORT_STYLE_PROMPT } from "../domain/weeklyReportStyle.js";

export type WeeklyReportStyleInput = {
  projectName: string;
  summaryDate: string;
  summary: string;
  githubId: string;
  previousReport: { reportId: number; weeklyNum: number; content: string };
  signal?: AbortSignal;
};

export interface WeeklyReportStyleSummarizer {
  summarize(input: WeeklyReportStyleInput): Promise<{
    content: string;
    interaction: ProjectProgressAiInteraction;
  }>;
}

export class CodexWeeklyReportStyleSummarizer implements WeeklyReportStyleSummarizer {
  constructor(
    private readonly config: { model: ProjectProgressConfig["model"]; workingDirectory: string },
    private readonly runner: WeeklyReportAgentRunner = runWeeklyReportAgent,
  ) {}

  async summarize(input: WeeklyReportStyleInput) {
    const startedAt = Date.now();
    input.signal?.throwIfAborted();
    const previousContent = input.previousReport.content.slice(0, 16_000);
    let content = `### ${input.projectName}\n${input.summary.trim()}`;
    let run: Awaited<ReturnType<WeeklyReportAgentRunner>> | null = null;
    let failed = false;
    try {
      if (input.summary.length > 20_000) throw new Error("Summary exceeds style input limit");
      run = await this.runner({
        model: this.config.model,
        codexExecutablePath: path.join(this.config.workingDirectory, "agent/scripts/isolatedCodexExec.mjs"),
        workingDirectory: this.config.workingDirectory,
        developerInstructions: WEEKLY_REPORT_STYLE_PROMPT,
        prompt: JSON.stringify({
          project_name: input.projectName,
          summary_date: input.summaryDate,
          current_summary: input.summary,
          previous_report: previousContent,
          previous_report_truncated: input.previousReport.content.length > previousContent.length,
        }),
        outputSchema: {
          type: "object", additionalProperties: false, required: ["content"],
          properties: { content: { type: "string", minLength: 1, maxLength: 20_000 } },
        },
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      const value = JSON.parse(run.finalResponse) as { content?: unknown };
      if (run.prohibitedToolUseCount || typeof value.content !== "string" ||
        !value.content.trim() || value.content.length > 20_000 ||
        /<!--|<\/?[a-z][^>]*>|```/iu.test(value.content) ||
        !value.content.includes(input.projectName)) {
        throw new Error("Invalid weekly style output");
      }
      content = value.content.trim();
    } catch {
      input.signal?.throwIfAborted();
      failed = true;
    }
    const interaction: ProjectProgressAiInteraction = {
      provider: this.config.model.provider, model: this.config.model.model,
      promptVersion: WEEKLY_REPORT_STYLE_PROMPT_VERSION, systemPromptSnapshot: WEEKLY_REPORT_STYLE_PROMPT,
      requestPayloadSanitized: {
        purpose: "weekly_report_style", github_id: input.githubId, summary_date: input.summaryDate,
        reference_report_id: input.previousReport.reportId,
        reference_weekly_num: input.previousReport.weeklyNum,
        reference_digest: createHash("sha256").update(input.previousReport.content).digest("hex"),
        reference_chars: previousContent.length,
        reference_truncated: input.previousReport.content.length > previousContent.length,
      },
      responsePayloadSanitized: { content }, finalSummary: content,
      limitations: failed ? ["周报风格改写失败，已使用原项目总结"] : [],
      fallbackUsed: failed, upstreamRequestId: run?.upstreamRequestId ?? null,
      inputTokens: run?.usage?.input_tokens ?? null, outputTokens: run?.usage?.output_tokens ?? null,
      latencyMs: Date.now() - startedAt, status: failed ? "fallback" : "succeeded",
      errorCode: failed ? "weekly_report_style_failed" : null,
      errorSummary: failed ? "周报风格改写失败，已使用原项目总结" : null,
    };
    return { content, interaction };
  }
}
