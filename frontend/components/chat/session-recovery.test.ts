import assert from "node:assert/strict"
import test from "node:test"
import { prepareChatSession, SessionUnavailableError } from "./session-recovery"

test("replaces a cached empty session only when OA confirms it is missing", async () => {
  let creates = 0
  const id = await prepareChatSession({
    sessionId: "41", hasMessages: false,
    load: async () => { throw new SessionUnavailableError() },
    create: async () => { creates++; return "42" },
  })
  assert.equal(id, "42")
  assert.equal(creates, 1)
})

test("preserves unavailable conversation history rather than silently replacing its session", async () => {
  await assert.rejects(prepareChatSession({
    sessionId: "41", hasMessages: true,
    load: async () => { throw new SessionUnavailableError() },
    create: async () => { assert.fail("must not replace existing history") },
  }), SessionUnavailableError)
})

test("does not create duplicate sessions on authentication or network failures", async () => {
  for (const message of ["unauthorized", "network unavailable"]) {
    const error = new Error(message)
    await assert.rejects(prepareChatSession({
      sessionId: "41", hasMessages: false,
      load: async () => { throw error },
      create: async () => { assert.fail("must not create a session") },
    }), error)
  }
})

test("keeps valid OA sessions and creates draft sessions without looking up a local ID", async () => {
  assert.equal(await prepareChatSession({
    sessionId: "41", hasMessages: true, load: async () => ({}),
    create: async () => { assert.fail("must keep valid session") },
  }), "41")
  assert.equal(await prepareChatSession({
    sessionId: "web-draft", hasMessages: false,
    load: async () => { assert.fail("draft has no OA record") }, create: async () => "42",
  }), "42")
})
