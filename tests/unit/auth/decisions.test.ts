import { assert, test } from "vitest";

import {
  decideAccountAccess,
  decideSignUpResult,
  safeAuthError,
} from "../../../src/lib/auth/decisions";

test("signup requires a user without an authenticated session", () => {
  assert.strictEqual(
    decideSignUpResult({ hasSession: true, hasUser: true, hasError: false }),
    "error",
  );
  assert.strictEqual(
    decideSignUpResult({ hasSession: false, hasUser: true, hasError: false }),
    "check-email",
  );
  assert.strictEqual(
    decideSignUpResult({ hasSession: false, hasUser: false, hasError: false }),
    "error",
  );
  assert.strictEqual(
    decideSignUpResult({ hasSession: false, hasUser: true, hasError: true }),
    "error",
  );
});

test("sign-in provider errors are mapped to a safe response", () => {
  assert.strictEqual(
    safeAuthError("signin", "unexpected_provider_error"),
    "Email or password is incorrect.",
  );
});

test("account access distinguishes active and suspended users", () => {
  assert.strictEqual(decideAccountAccess("active"), "active");
  assert.strictEqual(decideAccountAccess("suspended"), "suspended");
  assert.strictEqual(decideAccountAccess(undefined), "structural-error");
  assert.strictEqual(decideAccountAccess("unknown"), "structural-error");
});
