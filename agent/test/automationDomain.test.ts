import assert from "node:assert/strict";
import test from "node:test";

import {
  AutomationDomainError,
  digestLeaseToken,
  ensureRunTransition,
  redactSensitiveData,
  sanitizeErrorSummary,
  verifyLeaseToken,
} from "../src/automation/domain.js";

test("allows worker run transitions and idempotent terminal updates", () => {
  assert.doesNotThrow(() => ensureRunTransition("pending", "claimed"));
  assert.doesNotThrow(() => ensureRunTransition("claimed", "running"));
  assert.doesNotThrow(() => ensureRunTransition("running", "succeeded"));
  assert.doesNotThrow(() => ensureRunTransition("succeeded", "succeeded"));

  assert.throws(
    () => ensureRunTransition("succeeded", "running"),
    (error: unknown) =>
      error instanceof AutomationDomainError &&
      error.code === "invalid_run_transition",
  );
});

test("hashes and compares lease tokens without storing the raw token", () => {
  const token = "a".repeat(64);
  const digest = digestLeaseToken(token);

  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(verifyLeaseToken(token, digest), true);
  assert.equal(verifyLeaseToken("b".repeat(64), digest), false);
});

test("recursively redacts secrets and removes unsafe error lines", () => {
  assert.deepEqual(
    redactSensitiveData({
      nested: { Authorization: "Bearer secret", value: 7 },
      list: [{ api_key: "secret" }],
    }),
    {
      nested: { Authorization: "***", value: 7 },
      list: [{ api_key: "***" }],
    },
  );

  assert.equal(
    sanitizeErrorSummary(
      "project 9 failed\nAuthorization: Bearer abc\nSELECT token FROM user",
    ),
    "project 9 failed",
  );
});

