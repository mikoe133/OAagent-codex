import assert from "node:assert/strict"
import test from "node:test"
import { createMessageListScroll } from "./message-list-scroll"

function setup() {
  const viewport = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 }
  const frames = new Map<number, () => void>()
  let id = 0
  let atBottom = false
  const scroll = createMessageListScroll(viewport, {
    request(callback) { frames.set(++id, callback); return id },
    cancel(id) { frames.delete(id) },
  }, (value) => { atBottom = value })
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback())
  }
  scroll.scrollToLatest()
  return { viewport, frames, scroll, flush, atBottom: () => atBottom }
}

test("stream growth follows the real bottom without a continuous animation", () => {
  const h = setup()
  h.viewport.scrollHeight += 300
  h.scroll.onResize()
  h.scroll.onResize()
  assert.equal(h.frames.size, 1)
  h.flush()
  assert.equal(h.viewport.scrollTop, 1700)
  assert.equal(h.atBottom(), true)
  assert.equal(h.frames.size, 0)
})

test("reading older messages cancels pending follow and the latest button restores it", () => {
  const h = setup()
  h.viewport.scrollHeight += 300
  h.scroll.onResize()
  h.scroll.pause()
  h.viewport.scrollTop = 400
  h.scroll.onScroll()
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 400)
  assert.equal(h.atBottom(), false)
  h.scroll.scrollToLatest()
  assert.equal(h.viewport.scrollTop, 1700)
  assert.equal(h.atBottom(), true)
  h.viewport.scrollHeight += 200
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1900)
})

test("scrollbar dragging during a reply pauses following without wheel events", () => {
  const h = setup()
  h.viewport.scrollTop = 800
  h.scroll.onScroll()
  h.viewport.scrollHeight += 300
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 800)
  assert.equal(h.atBottom(), false)
  h.viewport.scrollTop = 1700
  h.scroll.onScroll()
  h.viewport.scrollHeight += 100
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1800)
})

test("trace collapse and final answer expansion cannot strand the cached position", () => {
  const h = setup()
  h.viewport.scrollHeight = 1000
  h.viewport.scrollTop = 400 // Browser clamps the old offset when the content shrinks.
  h.scroll.onScroll()
  h.scroll.onResize()
  h.flush()
  h.viewport.scrollHeight = 3200
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 2600)
  assert.equal(h.atBottom(), true)
})

test("viewport and composer space changes keep the final message reachable", () => {
  const h = setup()
  h.viewport.clientHeight = 400
  h.viewport.scrollHeight += 160
  h.scroll.onResize()
  h.flush()
  assert.equal(h.viewport.scrollTop, 1760)
  assert.equal(h.atBottom(), true)
})

test("disposed conversation cancels its scheduled scrolling", () => {
  const h = setup()
  h.viewport.scrollHeight += 200
  h.scroll.onResize()
  h.scroll.dispose()
  h.flush()
  h.scroll.onResize()
  h.scroll.scrollToLatest()
  assert.equal(h.viewport.scrollTop, 1400)
  assert.equal(h.frames.size, 0)
})
