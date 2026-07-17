import assert from "node:assert/strict"
import test from "node:test"

import { resolveOaNavigationUrl } from "./oa-navigation"

const TEST_OA_FRONTEND_URL = "https://rwkv-oa.vercel.app/"
const PRODUCTION_OA_FRONTEND_URL = "https://oa.rwkvos.com/"

test("maps local and test OA API addresses to the test frontend", () => {
  for (const value of [
    undefined,
    "",
    "http://host.docker.internal:8010",
    "http://localhost:8010",
    "http://127.0.0.1:8010",
    "http://[::1]:8010",
    "https://api-oa-test.rwkvos.com",
  ]) {
    assert.equal(resolveOaNavigationUrl(value), TEST_OA_FRONTEND_URL)
  }
})

test("maps the production OA environment to the production frontend", () => {
  assert.equal(resolveOaNavigationUrl("https://api-oa.rwkvos.com"), PRODUCTION_OA_FRONTEND_URL)
  assert.equal(resolveOaNavigationUrl("https://oa.rwkvos.com"), PRODUCTION_OA_FRONTEND_URL)
})

test("keeps unknown and unsafe OA environment values on the test frontend", () => {
  assert.equal(resolveOaNavigationUrl("https://oa.example.com"), TEST_OA_FRONTEND_URL)
  assert.equal(resolveOaNavigationUrl("javascript:alert(1)"), TEST_OA_FRONTEND_URL)
  assert.equal(resolveOaNavigationUrl("not a url"), TEST_OA_FRONTEND_URL)
})
