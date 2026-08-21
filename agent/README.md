# Agent Backend

`agent` is the backend workspace for the OA agent service. It owns the runtime
code, prompts, controlled OA API helper script, and OpenAPI contract.

## Layout

```text
agent/
  openapi/openapi.json     Local fallback for the OA OpenAPI contract
  knowledgebaseapi/        Knowledge-base read contract, guide, and write placeholder
  prompts/                 Agent prompt files loaded in deterministic order
  scripts/                 Backend maintenance and controlled tool scripts
  src/
    api/                   HTTP routes, request parsing, response shaping
    application/           Use cases and orchestration services
    config/                Environment loading and startup validation
    domain/                Domain types, policies, and errors without I/O
    infrastructure/
      codex/               Codex SDK client and thread adapters
      oa/                  OA OpenAPI tool/client adapters
      persistence/         Session store and durable runtime state
      prompts/             Prompt loading adapters
    middleware/            Auth, logging, limits, and shared HTTP guards
    runtime/               Process entrypoints and server bootstrap
    tools/                 Agent-callable tools with safety boundaries
  tests/                   Backend unit, integration, and API tests
```

## Commands

From the repository root:

```bash
npm run dev -- "我想查一下周报列表,应该调用哪个接口?"
npm run dev:server
npm run typecheck
```

From this workspace:

```bash
npm run dev -- "我想查一下周报列表,应该调用哪个接口?"
npm run dev:server
npm run build
npm run typecheck
```

The backend loads environment variables from the repository root `.env`, then
from `agent/.env` if present. Values in `agent/.env` override root values.

For each agent task and controlled OA API call, the backend first requests
`OA_OPENAPI_URL` (default: `https://api-oa.rwkvos.com/openapi_json`). A valid
remote OpenAPI document is materialized under `agent/.context/openapi/` for the
Codex subprocess. Network errors, non-2xx responses, and invalid OpenAPI JSON
fall back to `agent/openapi/openapi.json`.

Knowledge-document questions route separately through
`agent/knowledgebaseapi/knowledgebaseapi.yaml`. Configure
`OA_KNOWLEDGE_API_KEY` (and optionally `OA_KNOWLEDGE_API_BASE_URL`) to enable
real reads. The reserved write contract is
`agent/knowledgebaseapi/knowledgebase-write-api.yaml`; until it exists, the
router will not substitute an OA operation for a knowledge-base mutation.
