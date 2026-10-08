import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

import { shouldSubmitComposerOnKeyDown } from "./composer-keyboard"

require.extensions[".css"] = () => undefined

const composerSource = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8")

test("does not submit while an input method is composing text", () => {
  assert.equal(
    shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: true,
      keyCode: 13,
    }),
    false,
  )
})

test("does not submit Safari composition confirmation key events", () => {
  assert.equal(
    shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 229,
    }),
    false,
  )
})

test("submits Enter after input method composition has ended", () => {
  assert.equal(
    shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: false,
      isComposing: false,
      keyCode: 13,
    }),
    true,
  )
})

test("keeps Shift+Enter available for new lines", () => {
  assert.equal(
    shouldSubmitComposerOnKeyDown({
      key: "Enter",
      shiftKey: true,
      isComposing: false,
      keyCode: 13,
    }),
    false,
  )
})

test("Composer uses the composition-aware keyboard guard before sending", () => {
  assert.match(composerSource, /shouldSubmitComposerOnKeyDown\(/)
})

test("the composer masks replies after they scroll beneath the input", () => {
  assert.match(composerSource, /data-slot="chat-composer-mask"/)
  assert.match(composerSource, /absolute -bottom-4 left-0 right-4 top-0 bg-stone-50 theme-dark:bg-zinc-950/)
  assert.match(composerSource, /relative z-10 max-w-2xl mx-auto pointer-events-auto/)
})

test("the current nexttoken model opens model selection with attachments available and voice hidden", async () => {
  const { Composer } = await import("./composer")
  const html = renderToStaticMarkup(
    <Composer
      onSend={() => undefined}
      onStop={() => undefined}
      isStreaming={false}
      selectedProvider="nexttoken"
      selectedModel="gpt-5.6-terra"
      onModelChange={() => undefined}
    />,
  )

  const modelTrigger = html.match(
    /<button[^>]*aria-label="Select AI model"[^>]*>([\s\S]*?)<\/button>/,
  )

  assert.ok(modelTrigger, "expected an accessible model selector button")
  assert.match(modelTrigger[1], /GPT-5\.6 Terra/)
  assert.doesNotMatch(html, /aria-label="(?:Start|Stop) voice input"/)
  assert.match(html, /aria-label="添加图片或文件"/)
  assert.match(html, /aria-label="选择图片和文件"/)
})

test("shows the selected OpenRouter GLM model in the composer", async () => {
  const { Composer } = await import("./composer")
  const html = renderToStaticMarkup(
    <Composer
      onSend={() => undefined}
      onStop={() => undefined}
      isStreaming={false}
      selectedProvider="openrouter"
      selectedModel="z-ai/glm-5.3"
      onModelChange={() => undefined}
    />,
  )

  assert.match(html, /GLM-5\.3/)
})

test("shows disabled models in gray with a hover hint", () => {
  assert.match(composerSource, /disabled=\{modelDisabled\}/)
  assert.match(composerSource, /title=\{modelDisabled \? "暂不支持" : undefined\}/)
  assert.match(composerSource, /data-\[disabled\]:pointer-events-auto/)
  assert.doesNotMatch(composerSource, />暂不可用</)
})

test("keeps model names on one line in the selection dropdown", () => {
  assert.match(
    composerSource,
    /<span className="min-w-0 flex-1 truncate whitespace-nowrap text-sm" title=\{model\.name\}>\{model\.name\}<\/span>/,
  )
})

test('renders the operation plan and both confirmation buttons above the input', async () => {
  const { Composer } = await import('./composer')
  const html = renderToStaticMarkup(<Composer
    onSend={() => undefined} onStop={() => undefined} isStreaming={false}
    selectedProvider="openrouter" selectedModel="deepseek/deepseek-v4.1-flash" onModelChange={() => undefined}
    confirmation={{ id: '983c3194-2fab-45a9-a643-ea1a99a2440f', title: '创建测试目录', description: '在指定知识库创建目录并上传附件', actions: ['创建目录', '上传附件'], expiresAt: '2099-01-01T00:00:00.000Z' }}
    onConfirmationRespond={async () => true}
  />)
  assert.match(html, /等待你的确认/)
  assert.match(html, /创建测试目录/)
  assert.match(html, /确认执行/)
  assert.match(html, />取消<\/button>/)
  assert.ok(html.indexOf('data-slot="chat-confirmation"') < html.indexOf('<textarea'))
})

test('expired or streaming confirmations cannot be clicked', async () => {
  const { ConfirmationCard } = await import('./confirmation-card')
  const confirmation = { id: '983c3194-2fab-45a9-a643-ea1a99a2440f', title: '创建目录', description: '说明', actions: ['创建目录'], expiresAt: '2099-01-01T00:00:00.000Z' }
  for (const props of [{ confirmation, disabled: true }, { confirmation: { ...confirmation, expiresAt: '2000-01-01T00:00:00.000Z' } }]) {
    const html = renderToStaticMarkup(<ConfirmationCard {...props} onRespond={async () => true} />)
    assert.equal((html.match(/<button[^>]*disabled=""/g) ?? []).length, 2)
  }
})
