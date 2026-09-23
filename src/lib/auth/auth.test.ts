import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_CONFIRMED_MESSAGE,
  authCallbackDestination,
  decideAuthCallbackOutcome,
  isEmailConfirmationCallback,
  supportedOtpType,
} from "./callback.ts";
import {
  SIGNUP_CONFIRMATION_DESCRIPTION,
  SIGNUP_CONFIRMATION_TITLE,
} from "./confirmation.ts";
import {
  RECOVERY_SUCCESS_MESSAGE,
  decideAccountAccess,
  decideSignUpResult,
  safeAuthError,
} from "./decisions.ts";
import { changePasswordWithVerification } from "./password-change.ts";
import { loginPath, safeRedirectPath } from "./redirects.ts";
import { getApplicationUrl } from "./site-url.ts";
import {
  changePasswordSchema,
  fieldValidationErrors,
  newPasswordSchema,
  signUpSchema,
} from "./validation.ts";

test("signup validates required credentials", () => {
  assert.equal(
    signUpSchema.safeParse({
      email: "not-an-email",
      password: "short",
      confirmPassword: "short",
    }).success,
    false,
  );
});

test("signup rejects mismatched password confirmation", () => {
  const result = signUpSchema.safeParse({
    email: "member@example.com",
    password: "password-one",
    confirmPassword: "password-two",
  });

  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected signup validation to fail.");
  assert.equal(result.error.issues[0]?.message, "Passwords do not match.");
  assert.deepEqual(fieldValidationErrors(result.error), {
    confirmPassword: "Passwords do not match.",
  });
});

test("signup validation maps errors to their corresponding fields", () => {
  const result = signUpSchema.safeParse({
    email: "not-an-email",
    password: "short",
    confirmPassword: "short",
  });

  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected signup validation to fail.");
  assert.deepEqual(fieldValidationErrors(result.error), {
    email: "Enter a valid email address.",
    password: "Password must be at least 6 characters long.",
  });
});

test("reset password rejects mismatched confirmation", () => {
  assert.equal(
    newPasswordSchema.safeParse({
      password: "password-one",
      confirmPassword: "password-two",
    }).success,
    false,
  );
});

test("authenticated password changes require the current password", () => {
  const result = changePasswordSchema.safeParse({
    currentPassword: "",
    password: "new-password",
    confirmPassword: "new-password",
  });

  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.equal(result.error.issues[0]?.message, "Enter your current password.");
});

test("authenticated password changes reject mismatched confirmation", () => {
  const result = changePasswordSchema.safeParse({
    currentPassword: "current-password",
    password: "new-password-one",
    confirmPassword: "new-password-two",
  });

  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.equal(result.error.issues[0]?.message, "Passwords do not match.");
});

test("authenticated password changes reject reusing the current password", () => {
  const result = changePasswordSchema.safeParse({
    currentPassword: "current-password",
    password: "current-password",
    confirmPassword: "current-password",
  });

  assert.equal(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.deepEqual(fieldValidationErrors(result.error), {
    password: "New password must be different from your current password.",
  });
});

test("verified current password permits the authenticated password update", async () => {
  let updateCalls = 0;
  let verificationSignOutCalls = 0;
  const result = await changePasswordWithVerification({
    authenticatedClient: {
      auth: {
        async updateUser({ password }) {
          updateCalls += 1;
          assert.equal(password, "new-password");
          return { error: null };
        },
      },
    },
    verificationClient: {
      auth: {
        async signInWithPassword({ email, password }) {
          assert.equal(email, "member@example.com");
          assert.equal(password, "current-password");
          return { data: { user: { id: "user-id" } }, error: null };
        },
        async signOut() {
          verificationSignOutCalls += 1;
          return { error: null };
        },
      },
    },
    userId: "user-id",
    email: "member@example.com",
    currentPassword: "current-password",
    newPassword: "new-password",
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(updateCalls, 1);
  assert.equal(verificationSignOutCalls, 1);
});

test("incorrect current password never attempts the password update", async () => {
  let updateCalls = 0;
  const result = await changePasswordWithVerification({
    authenticatedClient: {
      auth: {
        async updateUser() {
          updateCalls += 1;
          return { error: null };
        },
      },
    },
    verificationClient: {
      auth: {
        async signInWithPassword() {
          return { data: { user: null }, error: { code: "invalid_credentials" } };
        },
        async signOut() {
          return { error: null };
        },
      },
    },
    userId: "user-id",
    email: "member@example.com",
    currentPassword: "incorrect-password",
    newPassword: "new-password",
  });

  assert.deepEqual(result, { ok: false, reason: "current-password-incorrect" });
  assert.equal(updateCalls, 0);
});

test("signup requires a user without an authenticated session", () => {
  assert.equal(
    decideSignUpResult({ hasSession: true, hasUser: true, hasError: false }),
    "error",
  );
  assert.equal(
    decideSignUpResult({ hasSession: false, hasUser: true, hasError: false }),
    "check-email",
  );
  assert.equal(
    decideSignUpResult({ hasSession: false, hasUser: false, hasError: false }),
    "error",
  );
  assert.equal(
    decideSignUpResult({ hasSession: false, hasUser: true, hasError: true }),
    "error",
  );
});

test("confirmation-pending content explains the required next step", () => {
  assert.equal(SIGNUP_CONFIRMATION_TITLE, "Check your email");
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /account was created/i);
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /confirmation email was sent/i);
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /confirm your email address/i);
});

test("signup confirmation callbacks retain the safe authenticated destination", () => {
  assert.equal(supportedOtpType("signup"), "signup");
  assert.equal(supportedOtpType("email"), "email");
  assert.equal(authCallbackDestination("/account", "signup"), "/account");
  assert.equal(
    authCallbackDestination("https://attacker.example", "signup"),
    "/account",
  );
  assert.equal(authCallbackDestination("/account", "recovery"), "/reset-password");
});

test("confirmation callback succeeds when its session is established", () => {
  assert.equal(
    decideAuthCallbackOutcome({
      verificationSucceeded: true,
      sessionEstablished: true,
      isEmailConfirmation: true,
    }),
    "authenticated",
  );
});

test("confirmed email without a session asks the user to sign in", () => {
  assert.equal(
    decideAuthCallbackOutcome({
      verificationSucceeded: true,
      sessionEstablished: false,
      isEmailConfirmation: true,
    }),
    "confirmed-sign-in-required",
  );
  assert.equal(
    EMAIL_CONFIRMED_MESSAGE,
    "Your email has been confirmed. Please sign in.",
  );
  assert.equal(
    isEmailConfirmationCallback({
      flow: "email-confirmation",
      type: null,
      next: "/account",
      hasCode: true,
    }),
    true,
  );
});

test("invalid or expired verification remains an invalid callback", () => {
  assert.equal(
    decideAuthCallbackOutcome({
      verificationSucceeded: false,
      sessionEstablished: false,
      isEmailConfirmation: true,
    }),
    "invalid",
  );
});

test("auth errors are mapped without exposing provider messages", () => {
  const rawMessage = "Supabase internal detail: user lookup failed";
  const mapped = safeAuthError("signin", "unexpected_provider_error");

  assert.equal(mapped, "Email or password is incorrect.");
  assert.equal(mapped.includes(rawMessage), false);
});

test("password recovery response does not disclose account existence", () => {
  const existingAccountResponse = RECOVERY_SUCCESS_MESSAGE;
  const missingAccountResponse = RECOVERY_SUCCESS_MESSAGE;

  assert.equal(existingAccountResponse, missingAccountResponse);
  assert.match(existingAccountResponse, /If an account exists/);
});

test("account access distinguishes active and suspended users", () => {
  assert.equal(decideAccountAccess("active"), "active");
  assert.equal(decideAccountAccess("suspended"), "suspended");
  assert.equal(decideAccountAccess(undefined), "structural-error");
  assert.equal(decideAccountAccess("unknown"), "structural-error");
});

test("safe redirects accept local paths and preserve their query", () => {
  assert.equal(safeRedirectPath("/account?section=password"), "/account?section=password");
  assert.equal(loginPath("/account?section=password"), "/login?next=%2Faccount%3Fsection%3Dpassword");
});

test("safe redirects reject external and protocol-relative destinations", () => {
  assert.equal(safeRedirectPath("https://attacker.example/path"), "/account");
  assert.equal(safeRedirectPath("//attacker.example/path"), "/account");
  assert.equal(safeRedirectPath("/\\attacker.example/path"), "/account");
  assert.equal(safeRedirectPath("account"), "/account");
});

test("application URLs cannot escape the configured origin", () => {
  const previousUrl = process.env.APP_URL;
  process.env.APP_URL = "https://club.example";

  try {
    assert.equal(
      getApplicationUrl("/auth/callback?next=/account"),
      "https://club.example/auth/callback?next=/account",
    );
    assert.throws(
      () => getApplicationUrl("//attacker.example/path"),
      /must stay on APP_URL/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousUrl;
  }
});

test("production application URLs require APP_URL", () => {
  const previousUrl = process.env.APP_URL;
  const previousEnvironment = process.env.NODE_ENV;
  Reflect.deleteProperty(process.env, "APP_URL");
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value: "production",
    writable: true,
  });

  try {
    assert.throws(
      () => getApplicationUrl("/auth/callback"),
      /APP_URL is required in production/,
    );
  } finally {
    if (previousUrl === undefined) Reflect.deleteProperty(process.env, "APP_URL");
    else process.env.APP_URL = previousUrl;
    if (previousEnvironment === undefined) {
      Reflect.deleteProperty(process.env, "NODE_ENV");
    } else {
      Object.defineProperty(process.env, "NODE_ENV", {
        configurable: true,
        enumerable: true,
        value: previousEnvironment,
        writable: true,
      });
    }
  }
});
