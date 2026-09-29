# Font layout validation — 2026-09-29

- Removed the disabled OpenRouter `openai/gpt-5.6` option. Nexttoken GPT models remain available. Existing invalid saved model selections fall back to the provider default.
- Large (18px root) and extra-large (20px root) tested with real ChatShell/Composer/Sider/Markdown components in a temporary local preview using synthetic messages and mocked read-only API responses.
- Checked viewport widths 320, 390, 768, 1024, 1280px at 844px height. In all ten combinations, document width matched the viewport and message scrollWidth matched clientWidth. Desktop message offsets matched the rendered sidebar (360px / 400px); narrower views used the drawer. Measurements: `layout-checks.json`.
- Verified desktop collapse/expand, live font switching, multiline input, image selection, last-message visibility, five-model menu, and accessible font submenu selection on phones. Nested settings use a viewport-bound panel on narrow screens.
- Long URLs wrap; wide tables and code scroll inside their own containers. Composer height drives bottom spacing and the latest-message control.
- Frontend chat suite: 236 passed. Frontend TypeScript check and production build passed. `git diff --check` passed.
- Screenshots: `extra-large-desktop.png`, `extra-large-mobile.png`. Preview route removed; viewport override reset and preview tab closed. No remote deployment.
