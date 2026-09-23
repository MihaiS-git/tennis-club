import { assert, test } from "vitest";

import {
  EMAIL_CONFIRMED_MESSAGE,
  authCallbackDestination,
  decideAuthCallbackOutcome,
  isEmailConfirmationCallback,
  supportedOtpType,
} from "../../../src/lib/auth/callback";
import {
  SIGNUP_CONFIRMATION_DESCRIPTION,
  SIGNUP_CONFIRMATION_TITLE,
} from "../../../src/lib/auth/confirmation";
import {
  RECOVERY_SUCCESS_MESSAGE,
  decideAccountAccess,
  decideSignUpResult,
  safeAuthError,
} from "../../../src/lib/auth/decisions";
import { changePasswordWithVerification } from "../../../src/lib/auth/password-change";
import { loginPath, safeRedirectPath } from "../../../src/lib/auth/redirects";
import { getApplicationUrl } from "../../../src/lib/auth/site-url";
import {
  changePasswordSchema,
  fieldValidationErrors,
  newPasswordSchema,
  signUpSchema,
} from "../../../src/lib/auth/validation";

test("signup validates required credentials", () => {
  assert.strictEqual(
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

  assert.strictEqual(result.success, false);
  if (result.success) throw new Error("Expected signup validation to fail.");
  assert.strictEqual(result.error.issues[0]?.message, "Passwords do not match.");
  assert.deepStrictEqual(fieldValidationErrors(result.error), {
    confirmPassword: "Passwords do not match.",
  });
});

test("signup validation maps errors to their corresponding fields", () => {
  const result = signUpSchema.safeParse({
    email: "not-an-email",
    password: "short",
    confirmPassword: "short",
  });

  assert.strictEqual(result.success, false);
  if (result.success) throw new Error("Expected signup validation to fail.");
  assert.deepStrictEqual(fieldValidationErrors(result.error), {
    email: "Enter a valid email address.",
    password: "Password must be at least 6 characters long.",
  });
});

test("reset password rejects mismatched confirmation", () => {
  assert.strictEqual(
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

  assert.strictEqual(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.strictEqual(result.error.issues[0]?.message, "Enter your current password.");
});

test("authenticated password changes reject mismatched confirmation", () => {
  const result = changePasswordSchema.safeParse({
    currentPassword: "current-password",
    password: "new-password-one",
    confirmPassword: "new-password-two",
  });

  assert.strictEqual(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.strictEqual(result.error.issues[0]?.message, "Passwords do not match.");
});

test("authenticated password changes reject reusing the current password", () => {
  const result = changePasswordSchema.safeParse({
    currentPassword: "current-password",
    password: "current-password",
    confirmPassword: "current-password",
  });

  assert.strictEqual(result.success, false);
  if (result.success) throw new Error("Expected password change validation to fail.");
  assert.deepStrictEqual(fieldValidationErrors(result.error), {
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
          assert.strictEqual(password, "new-password");
          return { error: null };
        },
      },
    },
    verificationClient: {
      auth: {
        async signInWithPassword({ email, password }) {
          assert.strictEqual(email, "member@example.com");
          assert.strictEqual(password, "current-password");
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

  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(updateCalls, 1);
  assert.strictEqual(verificationSignOutCalls, 1);
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

  assert.deepStrictEqual(result, { ok: false, reason: "current-password-incorrect" });
  assert.strictEqual(updateCalls, 0);
});

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

test("confirmation-pending content explains the required next step", () => {
  assert.strictEqual(SIGNUP_CONFIRMATION_TITLE, "Check your email");
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /account was created/i);
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /confirmation email was sent/i);
  assert.match(SIGNUP_CONFIRMATION_DESCRIPTION, /confirm your email address/i);
});

test("signup confirmation callbacks retain the safe authenticated destination", () => {
  assert.strictEqual(supportedOtpType("signup"), "signup");
  assert.strictEqual(supportedOtpType("email"), "email");
  assert.strictEqual(authCallbackDestination("/account", "signup"), "/account");
  assert.strictEqual(
    authCallbackDestination("https://attacker.example", "signup"),
    "/account",
  );
  assert.strictEqual(authCallbackDestination("/account", "recovery"), "/reset-password");
});

test("confirmation callback succeeds when its session is established", () => {
  assert.strictEqual(
    decideAuthCallbackOutcome({
      verificationSucceeded: true,
      sessionEstablished: true,
      isEmailConfirmation: true,
    }),
    "authenticated",
  );
});

test("confirmed email without a session asks the user to sign in", () => {
  assert.strictEqual(
    decideAuthCallbackOutcome({
      verificationSucceeded: true,
      sessionEstablished: false,
      isEmailConfirmation: true,
    }),
    "confirmed-sign-in-required",
  );
  assert.strictEqual(
    EMAIL_CONFIRMED_MESSAGE,
    "Your email has been confirmed. Please sign in.",
  );
  assert.strictEqual(
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
  assert.strictEqual(
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

  assert.strictEqual(mapped, "Email or password is incorrect.");
  assert.strictEqual(mapped.includes(rawMessage), false);
});

test("password recovery response does not disclose account existence", () => {
  const existingAccountResponse = RECOVERY_SUCCESS_MESSAGE;
  const missingAccountResponse = RECOVERY_SUCCESS_MESSAGE;

  assert.strictEqual(existingAccountResponse, missingAccountResponse);
  assert.match(existingAccountResponse, /If an account exists/);
});

test("account access distinguishes active and suspended users", () => {
  assert.strictEqual(decideAccountAccess("active"), "active");
  assert.strictEqual(decideAccountAccess("suspended"), "suspended");
  assert.strictEqual(decideAccountAccess(undefined), "structural-error");
  assert.strictEqual(decideAccountAccess("unknown"), "structural-error");
});

test("safe redirects accept local paths and preserve their query", () => {
  assert.strictEqual(safeRedirectPath("/account?section=password"), "/account?section=password");
  assert.strictEqual(loginPath("/account?section=password"), "/login?next=%2Faccount%3Fsection%3Dpassword");
});

test("missing next destinations use the account page", () => {
  assert.strictEqual(safeRedirectPath(null), "/account");
  assert.strictEqual(authCallbackDestination(null, null), "/account");
});

test("safe redirects reject external and protocol-relative destinations", () => {
  assert.strictEqual(safeRedirectPath("https://attacker.example/path"), "/account");
  assert.strictEqual(safeRedirectPath("//attacker.example/path"), "/account");
  assert.strictEqual(safeRedirectPath("/\\attacker.example/path"), "/account");
  assert.strictEqual(safeRedirectPath("account"), "/account");
});

test("malformed next destinations cannot redirect outside the application", () => {
  assert.strictEqual(safeRedirectPath("javascript:alert(1)"), "/account");
  assert.strictEqual(safeRedirectPath("/\n/attacker.example/path"), "/account");
});

test("application URLs cannot escape the configured origin", () => {
  const previousUrl = process.env.APP_URL;
  process.env.APP_URL = "https://club.example";

  try {
    assert.strictEqual(
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

test("development application URLs use localhost when APP_URL is absent", () => {
  const previousUrl = process.env.APP_URL;
  const previousEnvironment = process.env.NODE_ENV;
  Reflect.deleteProperty(process.env, "APP_URL");
  Object.defineProperty(process.env, "NODE_ENV", {
    configurable: true,
    enumerable: true,
    value: "development",
    writable: true,
  });

  try {
    assert.strictEqual(
      getApplicationUrl("/auth/callback?next=/account"),
      "http://localhost:3000/auth/callback?next=/account",
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
