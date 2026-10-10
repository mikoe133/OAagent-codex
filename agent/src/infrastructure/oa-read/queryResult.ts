import type { TextSelection } from './queryCompiler.js';

type ResultPlan = { id?: string; limit: number; offset: number; textSelections: TextSelection[] };
type TextFieldCoverage = { field: string; textOffset: number; textLength: number; truncated: boolean };
export type TextCoverage = { excerptsOnly: boolean; fields: TextFieldCoverage[] };

export function boundRows(rows: Record<string, unknown>[], compiled: ResultPlan, maxBytes: number) {
  const result: Record<string, unknown>[] = [];
  const fields = new Map<string, TextFieldCoverage>();
  let bytes = 0;
  let hasMore = rows.length > compiled.limit;
  for (const original of rows.slice(0, compiled.limit)) {
    const row = { ...original };
    const rowFields: TextFieldCoverage[] = [];
    for (const selection of compiled.textSelections) {
      const value = row[selection.field];
      if (typeof value !== 'string') continue;
      // MySQL SUBSTRING counts characters, not UTF-16 code units.
      const characters = value.length > selection.textLength ? Array.from(value) : undefined;
      const truncated = !!characters && characters.length > selection.textLength;
      if (truncated) row[selection.field] = characters.slice(0, selection.textLength).join('');
      if (selection.previewRequested || truncated || (characters?.length ?? value.length) === selection.textLength) {
        rowFields.push({ field: selection.field, textOffset: selection.textOffset, textLength: selection.textLength, truncated });
      }
    }
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > maxBytes) { hasMore = true; break; }
    result.push(row); bytes += size;
    for (const field of rowFields) fields.set(field.field, { ...field, truncated: field.truncated || !!fields.get(field.field)?.truncated });
  }
  if (!result.length && rows.length) throw Object.assign(new Error('单行结果过大，请减少返回字段或 textLength。'), { code: 'result_too_wide' });
  const textFields = [...fields.values()];
  return { ...(compiled.id ? { id: compiled.id } : {}), rows: result, returned: result.length, hasMore, nextOffset: hasMore ? compiled.offset + result.length : null,
    coverage: hasMore ? 'partial' : compiled.offset ? 'last_page' : 'complete',
    ...(textFields.length ? { textCoverage: { excerptsOnly: textFields.some(field => field.truncated || field.textOffset > 0), fields: textFields } } : {}),
  };
}
