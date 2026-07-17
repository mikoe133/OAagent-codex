import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

require.extensions[".css"] = () => undefined

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
      selectedModel="z-ai/glm-5.2"
      onModelChange={() => undefined}
    />,
  )

  assert.match(html, /GLM-5\.2/)
})
