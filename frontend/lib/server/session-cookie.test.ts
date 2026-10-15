import assert from "node:assert/strict"
import test from "node:test"

import { readSessionToken } from "./session-cookie"

test("reads quoted session cookies and decodes their value exactly once", () => {
  const token = "literal%3D-token+/=="
  for (const value of [encodeURIComponent(token), `"${encodeURIComponent(token)}"`]) {
    const request = new Request("https://frontend.test", {
      headers: { cookie: `unrelated=1; sessionid=${value}; other=value` },
    })
    assert.equal(readSessionToken(request), token)
  }
})

test("rejects missing, empty, malformed and unsafe session cookies", () => {
  for (const cookie of ["", "unrelated=1", "sessionid=", 'sessionid=""',
    "sessionid=broken%ZZ", 'sessionid="unclosed', "sessionid=bad%0D%0Aheader"]) {
    assert.equal(readSessionToken(new Request("https://frontend.test", { headers: { cookie } })), null)
  }
})
