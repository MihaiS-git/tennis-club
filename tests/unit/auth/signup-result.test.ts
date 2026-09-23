import { assert, describe, it } from "vitest";

import { getSignUpSessionOutcome } from "../../../src/lib/auth/signup-result";

describe("signup session outcome", () => {
  it("continues to the authenticated flow when signup returns a session", () => {
    assert.strictEqual(getSignUpSessionOutcome({}), "authenticated");
  });

  it("uses the check-email flow when signup returns no session", () => {
    assert.strictEqual(getSignUpSessionOutcome(null), "check-email");
  });
});
