import assert from 'node:assert/strict'
import test from 'node:test'
import { serverResponseDurationMs } from './response-duration'

const legacy = {
  state: 'completed', createdAt: '2026-10-15T06:05:08.893Z', updatedAt: '2026-10-15T06:08:22.885Z',
}

test('live responses and recovered requests use their server duration, including zero', () => {
  assert.equal(serverResponseDurationMs({ durationMs: 47_525 }), 47_525)
  assert.equal(serverResponseDurationMs({ ...legacy, durationMs: 0 }), 0)
  assert.equal(serverResponseDurationMs({ ...legacy, result: { durationMs: 47_525 } }), 47_525)
  assert.equal(serverResponseDurationMs(legacy), 193_992)
})

test('missing or invalid server timing never falls back to the browser clock', () => {
  for (const value of [null, undefined, {}, { durationMs: -1 }, { durationMs: Infinity },
    { ...legacy, createdAt: 'invalid' }, { ...legacy, state: 'running' },
    { ...legacy, state: 'unknown' }, { ...legacy, updatedAt: undefined }]) {
    assert.equal(serverResponseDurationMs(value), undefined)
  }
})
