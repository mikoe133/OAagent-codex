import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ProjectProgressConfig } from "../config/projectProgressConfig.js";
import { WEEKLY_REPORT_REWRITE_PROMPT, WEEKLY_REPORT_REWRITE_PROMPT_VERSION, WEEKLY_REPORT_REWRITE_REVIEW_PROMPT, weeklyReportRewriteInputSchema, type WeeklyReportRewriteInput } from "../domain/weeklyReportRewrite.js";
import { isInvalidProjectProgressSummary, type ProjectProgressAiInteraction } from "./projectProgressSummarizer.js";
import { runWeeklyReportAgent, type WeeklyReportAgentRunner, type WeeklyReportAgentRunResult } from "./weeklyReportAgentSummarizer.js";

const draftSchema = z.object({ content: z.string().trim().min(1), source_ids: z.array(z.string()).min(1) }).strict();
const outputSchema = {
  type: "object", additionalProperties: false, required: ["content", "source_ids"],
  properties: { content: { type: "string" }, source_ids: { type: "array", items: { type: "string" } } },
};
export interface WeeklyReportRewriter {
  rewrite(input: WeeklyReportRewriteInput, signal?: AbortSignal): Promise<{ content: string | null; interaction: ProjectProgressAiInteraction }>;
}
export const contentHash = (value: string) => createHash("sha256").update(value).digest("hex");

export class CodexWeeklyReportRewriter implements WeeklyReportRewriter {
  constructor(private readonly config: { model: ProjectProgressConfig["model"]; workingDirectory: string }, private readonly runner: WeeklyReportAgentRunner = runWeeklyReportAgent) {}

  async rewrite(input: WeeklyReportRewriteInput, signal?: AbortSignal) {
    const { context, summaries, summaryDate } = input;
    const startedAt = Date.now();
    const runs: WeeklyReportAgentRunResult[] = [];
    let content: string | null = null;
    let failure: string | null = null;
    let reviewApproved = false;
    const base = { model: this.config.model, workingDirectory: this.config.workingDirectory, codexExecutablePath: path.join(this.config.workingDirectory, "agent/scripts/isolatedCodexExec.mjs"), signal };
    try {
      signal?.throwIfAborted();
      weeklyReportRewriteInputSchema.parse(input);
      if (summaries.some((s) => isInvalidProjectProgressSummary(s.content))) throw new Error("weekly_report_invalid_daily_summary");
      // Strip only machine markers, never the text around them or user edits.
      const currentReport = context.content.replace(/<!--\s*oaagent-project-progress:[\s\S]*?-->/gu, "").trim();
      const sources = { summary_date: summaryDate, current_report: currentReport, daily_summaries: summaries };
      const facts = JSON.stringify(sources);
      if (facts.length > 120_000) throw new Error("weekly_report_input_too_large");
      const generated = await this.runner({ ...base, developerInstructions: WEEKLY_REPORT_REWRITE_PROMPT, prompt: facts, outputSchema });
      runs.push(generated);
      if (generated.prohibitedToolUseCount) throw new Error("weekly_report_prohibited_tool");
      const draft = draftSchema.parse(JSON.parse(generated.finalResponse));
      const candidate = draft.content;
      if (Array.from(candidate).length > 1000 || isInvalidProjectProgressSummary(candidate) || /<|>|```/u.test(candidate)) throw new Error("weekly_report_invalid_output");
      const expected = new Set([...(currentReport ? ["current-report"] : []), ...summaries.map((s) => s.source_id)]);
      if (draft.source_ids.some((id) => !expected.has(id)) || [...expected].some((id) => !draft.source_ids.includes(id))) throw new Error("weekly_report_invalid_citation");
      const reviewed = await this.runner({ ...base, developerInstructions: WEEKLY_REPORT_REWRITE_REVIEW_PROMPT, prompt: JSON.stringify({ ...sources, draft }), outputSchema: { type: "object", additionalProperties: false, required: ["approved", "issues"], properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } } } });
      runs.push(reviewed);
      const review = z.object({ approved: z.boolean(), issues: z.array(z.string()).max(100) }).strict().parse(JSON.parse(reviewed.finalResponse));
      if (reviewed.prohibitedToolUseCount || !review.approved || review.issues.length) throw new Error("weekly_report_fact_review_failed");
      signal?.throwIfAborted();
      reviewApproved = true;
      content = candidate;
    } catch (error) {
      signal?.throwIfAborted();
      // Do not store model output or raw upstream errors in error fields.
      failure = error instanceof Error && /^weekly_report_[a-z_]+$/.test(error.message) ? error.message : "weekly_report_rewrite_failed";
    }
    const usageKnown = runs.length > 0 && runs.every((r) => r.usage !== null);
    const interaction: ProjectProgressAiInteraction = {
      provider: this.config.model.provider, model: this.config.model.model,
      promptVersion: WEEKLY_REPORT_REWRITE_PROMPT_VERSION, systemPromptSnapshot: WEEKLY_REPORT_REWRITE_PROMPT,
      requestPayloadSanitized: { purpose: "weekly_report_rewrite", report_id: context.report_id, github_id: context.github_id, summary_date: summaryDate, expected_content_hash: context.content_hash, summary_count: summaries.length, input_digest: contentHash(JSON.stringify(input)), review_system_prompt_snapshot: WEEKLY_REPORT_REWRITE_REVIEW_PROMPT },
      responsePayloadSanitized: { review_approved: reviewApproved, model_calls: runs.length, rejection_reason: failure, output_digest: content === null ? null : contentHash(content) },
      finalSummary: content ?? "", limitations: failure ? ["整篇周报生成或事实核对失败，保留原周报"] : [],
      fallbackUsed: failure !== null, upstreamRequestId: runs[0]?.upstreamRequestId ?? null,
      inputTokens: usageKnown ? runs.reduce((s, r) => s + r.usage!.input_tokens, 0) : null,
      outputTokens: usageKnown ? runs.reduce((s, r) => s + r.usage!.output_tokens, 0) : null,
      latencyMs: Date.now() - startedAt, status: failure ? "fallback" : "succeeded", errorCode: failure,
      errorSummary: failure ? "整篇周报生成或事实核对失败，未覆盖原周报" : null,
    };
    return { content, interaction };
  }
}
