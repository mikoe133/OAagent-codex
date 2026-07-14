import assert from "node:assert/strict"
import test from "node:test"

import { renderToStaticMarkup } from "react-dom/server"

require.extensions[".css"] = () => undefined

test("the current model name opens model selection while voice and upload controls stay hidden", async () => {
  const { AI_MODELS, Composer } = await import("./composer")
  const html = renderToStaticMarkup(
    <Composer
      onSend={() => undefined}
      onStop={() => undefined}
      isStreaming={false}
      selectedModel="openai/gpt-5.4"
      onModelChange={() => undefined}
    />,
  )

  const modelTrigger = html.match(
    /<button[^>]*aria-label="Select AI model"[^>]*>([\s\S]*?)<\/button>/,
  )

  assert.ok(modelTrigger, "expected an accessible model selector button")
  assert.match(modelTrigger[1], /GPT-5\.4/)
  assert.deepEqual(
    AI_MODELS.map((model) => model.id),
    ["openai/gpt-5.5", "openai/gpt-5.4", "openai/gpt-5.4-mini", "openai/gpt-5.4-nano"],
  )
  assert.doesNotMatch(html, /aria-label="(?:Start|Stop) voice input"/)
  assert.doesNotMatch(html, /aria-label="Attach image"/)
  assert.doesNotMatch(html, /aria-label="Upload image"/)
})
