import { z } from 'zod';
import { queryId, querySchema } from './queryCompiler.js';

export const MAX_BATCH_QUERIES = 5;

// Single reads and each batch entry use the same envelope. Plans remain dynamic.
export const queryRequestSchema = z.object({ id: queryId.optional(), query: querySchema }).strict();
export type QueryRequest = z.output<typeof queryRequestSchema>;

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeQueryPlan(query: unknown): unknown {
  if (!record(query) || !('join' in query) || 'joins' in query) return query;
  const { join, ...rest } = query;
  return { ...rest, joins: join };
}

export function canonicalBatchEntry(raw: unknown): unknown {
  if (!record(raw)) return raw;
  if ('query' in raw) return { ...raw, query: normalizeQueryPlan(raw.query) };
  // Compatibility with previously published flat batch plans. Keep every key
  // so strict validation still rejects unknown fields rather than dropping them.
  const { id, ...query } = raw;
  return { ...(id === undefined ? {} : { id }), query: normalizeQueryPlan(query) };
}

export function validateQueryRequest(request: QueryRequest, context: z.RefinementCtx, path: (string | number)[] = []) {
  if (request.id !== undefined && request.query.id !== undefined && request.id !== request.query.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [...path, 'id'], message: '外层 id 与 query.id 不一致；只保留一个对应标识，或使用相同标识。' });
  }
}

export function queryPlanForRequest(request: QueryRequest) {
  return { ...request.query, ...(request.id === undefined ? {} : { id: request.id }) };
}
