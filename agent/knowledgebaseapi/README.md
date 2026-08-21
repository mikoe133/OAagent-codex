# Knowledge Base API Contracts

- `knowledgebaseapi.yaml`: current read contract for search, browsing, and page content.
- `AGENT_API.md`: authentication, permission, pagination, and calling guidance.
- `knowledgebase-write-api.yaml`: reserved write-contract path. The file is intentionally absent until the provider publishes the write API.

The runtime loads the read and write contracts as separate catalogs. Every operation from the future write contract requires explicit user confirmation in the controlled server-side tool.
