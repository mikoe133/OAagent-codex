import assert from 'node:assert/strict';
import test from 'node:test';
import { requestDurationMs, type RequestRecord } from '../src/chat/requestStore.js';

const request = {
  state: 'completed', createdAt: '2026-10-15T06:05:08.893Z', updatedAt: '2026-10-15T06:08:22.885Z',
} as RequestRecord;

test('legacy terminal requests use the same server timestamps as stored OA messages', () => {
  for (const state of ['completed', 'failed', 'cancelled'] as const) {
    assert.equal(requestDurationMs({ ...request, state }), 193_992);
  }
});

test('a saved terminal duration never increases during history sync or replay', () => {
  for (const durationMs of [0, 47_525]) {
    assert.equal(requestDurationMs({ ...request, durationMs, updatedAt: '2026-10-15T07:00:00.000Z' }), durationMs);
  }
});

test('unfinished requests and invalid timestamps have no completed duration', () => {
  for (const state of ['queued', 'running', 'unknown'] as const) {
    assert.equal(requestDurationMs({ ...request, state }), undefined);
  }
  assert.equal(requestDurationMs({ ...request, createdAt: 'invalid' }), undefined);
});

test('invalid saved durations fall back to server timestamps and clock regression is bounded', () => {
  for (const durationMs of [-1, NaN, Infinity]) {
    assert.equal(requestDurationMs({ ...request, durationMs }), 193_992);
  }
  assert.equal(requestDurationMs({ ...request, updatedAt: request.createdAt }), 0);
  assert.equal(requestDurationMs({ ...request, updatedAt: '2026-10-15T06:00:00.000Z' }), 0);
});
