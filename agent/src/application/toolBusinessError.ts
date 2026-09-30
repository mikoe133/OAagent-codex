// Only inspect the result envelope of controlled API tools, never arbitrary rows.
export function toolBusinessError(command: string, output: string): string | undefined {
  if (!/(?:callKnowledgeBaseApi|queryOaDatabase|callOaApi)\.mjs\b/.test(command)) return;
  try {
    const result = JSON.parse(output);
    if (result?.ok !== false) return;
    const message = result.error?.message ?? result.data?.error?.message;
    return typeof message === 'string' ? message.slice(0, 500) : '业务请求未成功';
  } catch { return; }
}
