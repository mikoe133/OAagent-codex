import { z } from 'zod';

// Return schema expectations, never submitted values or SQL/driver messages.
export function invalidQuery(error: z.ZodError, issueLimit = 8) {
  const issues = error.issues.slice(0, issueLimit).map(issue => ({
    path: issue.path.join('.') || '$',
    code: issue.code,
    message: issue.code === 'invalid_enum_value' ? `允许值：${issue.options.join(', ')}`
      : issue.code === 'unrecognized_keys' ? `不支持的参数：${issue.keys.slice(0, 8).map(key => key.slice(0, 80)).join(', ')}`
      : issue.code === 'invalid_type' ? `需要 ${issue.expected} 类型`
      : issue.message,
  }));
  return { ok: false as const, error: {
    code: 'invalid_query',
    message: `查询参数错误：${issues.map(i => `${i.path}: ${i.message}`).join('；')}`,
    issues,
    recovery: {
      action: 'correct_parameters',
      instruction: '只修正 issues 指出的结构参数，保留原对象、筛选和期间。不要删减业务条件试错，也不要扫描服务端源码。若同一错误再次出现，停止并说明具体参数问题。',
    },
  } };
}
