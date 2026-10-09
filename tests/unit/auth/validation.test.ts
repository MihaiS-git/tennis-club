import { assert, describe, it } from "vitest";

import { changePasswordSchema, fieldValidationErrors, signUpSchema, } from "../../../src/lib/auth/validation";

describe("authentication form validation", () => {

  it("maps sign-up validation errors to their fields", () => {
    const result = signUpSchema.safeParse({
      email: "not-an-email",
      password: "short",
      confirmPassword: "short",
    });

    assert.strictEqual(result.success, false);
    if (result.success) throw new Error("Expected signup validation to fail.");
    assert.deepStrictEqual(fieldValidationErrors(result.error), {
      email: "Enter a valid email address.",
      password: "Use at least 15 characters.",
    });
  });

  it("requires the current password for authenticated password changes", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "",
      password: "new-password-123",
      confirmPassword: "new-password-123",
    });

    assert.strictEqual(result.success, false);
    if (result.success) throw new Error("Expected password change validation to fail.");
    assert.strictEqual(result.error.issues[0]?.message, "Enter your current password.");
  });

  it("rejects reusing the current password", () => {
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

  it.each([
    ["change", (password: string) => changePasswordSchema.safeParse({ currentPassword: "current-password-123", password, confirmPassword: password })],
  ])("applies the same new-password policy to %s", (_flow, parse) => {
    const short = parse("a".repeat(14));
    assert.strictEqual(short.success, false);
    if (!short.success) assert.strictEqual(fieldValidationErrors(short.error).password, "Use at least 15 characters.");

    for (const password of ["a".repeat(15), "a".repeat(64), "a".repeat(72), "a long passphrase with spaces", "șțăîâé漢字 parola", "  leading and trailing spaces  "]) {
      const result = parse(password);
      assert.strictEqual(result.success, true, password);
      if (result.success) assert.strictEqual(result.data.password, password);
    }

    const long = parse("a".repeat(73));
    assert.strictEqual(long.success, false);
    if (!long.success) assert.strictEqual(fieldValidationErrors(long.error).password, "This password is too long. Use a shorter passphrase.");

    const longUnicode = parse("é".repeat(37));
    assert.strictEqual(longUnicode.success, false);
    if (!longUnicode.success) assert.strictEqual(fieldValidationErrors(longUnicode.error).password, "This password is too long. Use a shorter passphrase.");
  });
});
