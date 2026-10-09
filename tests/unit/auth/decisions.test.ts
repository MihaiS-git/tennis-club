import { assert, test } from "vitest";

import { safeAuthError, } from "../../../src/lib/auth/decisions";

test("sign-in provider errors are mapped to a safe response", () => {
  assert.strictEqual(
    safeAuthError("signin", "unexpected_provider_error"),
    "Email or password is incorrect.",
  );
});
