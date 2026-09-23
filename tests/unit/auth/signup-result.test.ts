import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSignUpSessionOutcome } from "../../../src/lib/auth/signup-result";

describe("signup session outcome", () => {
  it("continues to the authenticated flow when signup returns a session", () => {
    assert.equal(getSignUpSessionOutcome({}), "authenticated");
  });

  it("uses the check-email flow when signup returns no session", () => {
    assert.equal(getSignUpSessionOutcome(null), "check-email");
  });
});
