# Validation — 2026-09-29

- Initial attachment implementation: Agent suite 560 passed, 5 existing database integration skips.
- Frontend chat suite after purpose/model interaction update: 239 passed.
- Deployment suite: 61 passed.
- Agent and Next.js production builds passed. Both workspace TypeScript checks passed.
- After final storage filename and reverse-proxy origin fixes, targeted attachment/public-chat tests (10) and BFF attachment tests (3) passed again; Agent rebuilt and both TypeScript checks passed again.
- Initial browser smoke: multiple PNG/PDF selection, remove one attachment, failed-admission draft restoration and model capability labels. Current automatic interaction verification is below.
- Document worker: a real text PDF and generated DOCX (including Chinese) extracted successfully; malformed DOCX fails with a bounded, explicit error.
- OpenRouter live catalog: all 5 configured model IDs checked. Both Kimi K3 and Qwen passed a synthetic red-image probe via Responses and via the actual Codex SDK/model relay. See adjacent JSON reports. No private image was sent.
- Public HTTP tests cover OA ownership, authenticated download, attachment history persistence/replay, changed-request conflicts, invalid IDs, and automatic model routing for attachment analysis.
- Knowledge-base multipart forwarding tested against a mock transport using the repository OpenAPI contract. No production knowledge-base writes were performed.
- Docker was unavailable locally; no container build or remote deployment was performed. Updated Nginx attachment limits must be applied when deploying.

## Earlier automatic attachment routing update (superseded by semantic routing below)

- Removed purpose controls, target-page input, explanatory text, model filtering and single-use model buttons from the composer. Intent defaults to server-side automatic detection.
- Image and document analysis use the selected Kimi/Qwen model or automatically route the current request to Kimi K3. Pure upload, unclear intent and ordinary chat retain the requested model.
- Automatic switches produce a public `model_switch` progress event with the message “切换为 Kimi K3 模型用作文件解析（仅本次请求）”. Tests verify live SSE, saved history, request replay, no internal session ID leakage, and readable frontend trace restoration.
- Original model selection remains in idempotency/retry metadata; replay with the same selection succeeds and changing it conflicts. Default model preferences are unaffected.
- Agent suite: 561 passed, 5 existing database integration skips. Frontend suite: 236 passed. Both workspace TypeScript checks and production builds passed.
- Browser smoke: selected a synthetic PNG while DeepSeek V4 Flash remained selected, entered an analysis instruction, confirmed no purpose controls/help and enabled send, and sent successfully to a local capture harness. The captured request retained DeepSeek and automatic intent; backend routing is covered by authenticated HTTP tests. Screenshot: `automatic-composer.png`.
- Temporary UI preview route and browser tab removed after verification. No real knowledge-base writes or remote deployment performed.

## Unified semantic attachment routing (current behavior)

- Removed keyword-based attachment intent and frontend keyword-based history reuse. Existing GLM/DeepSeek router race now jointly decides API catalogs, attachment intent, vision requirement and preferred image model. No extra serial routing request.
- Text documents retain the selected model and receive server-extracted text. Image analysis switches unsupported selections to the routed Kimi/Qwen model. Upload-only stays on the selected model. Ignored prior files supply no bytes and no attachment-upload authorization.
- Structured decisions are validated. Invalid/missing decisions use bounded repair, then clarification with no API catalog, no vision switch and no write authorization. Upload decisions require a usable knowledge-base write route.
- Regression tests cover actual text preparation after mocked semantic routing, native image input, Qwen choice, race cancellation, failure/invalid output, document-model retention, contextual follow-up candidates, upload permissions, and live/history trace display.
- Live router probe: 8/8 synthetic cases passed (contextual TXT question, image question, pure upload, negated upload, unrelated follow-up, contextual follow-up, upload capability question, requested Qwen). Route duration 2528–3411 ms in this sample. Results: `semantic-routing-probe.json`; reproducible script: `semantic-routing-probe.mts`. This is routing evidence, not an end-to-end answer quality/latency benchmark; no real attachment data or production writes were sent.
- Final verification: Agent 565 passed, 5 existing database integration skips; frontend chat 237 passed. Both TypeScript checks and both production builds passed. Final Agent build rerun after fail-closed routing validation passed. No remote deployment performed.
