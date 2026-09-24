import { assert, test } from "vitest";

import {
  isEmailConfirmationCallback,
  supportedOtpType,
} from "../../../src/lib/auth/callback";

test("signup confirmation supports email and signup OTP types", () => {
  assert.strictEqual(supportedOtpType("signup"), "signup");
  assert.strictEqual(supportedOtpType("email"), "email");
});

test("email and signup OTP callbacks are classified as email confirmations", () => {
  assert.strictEqual(isEmailConfirmationCallback({ flow: null, type: "signup" }), true);
  assert.strictEqual(isEmailConfirmationCallback({ flow: null, type: "email" }), true);
});
