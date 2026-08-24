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

test("the current nexttoken model opens model selection while voice and upload controls stay hidden", async () => {
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
  assert.doesNotMatch(html, /aria-label="Attach image"/)
  assert.doesNotMatch(html, /aria-label="Upload image"/)
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
    /<span className="whitespace-nowrap text-sm">\{model\.name\}<\/span>/,
  )
})
