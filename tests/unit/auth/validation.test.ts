import { assert, describe, it } from "vitest";

import { signInSchema, signUpSchema } from "../../../src/lib/auth/validation";

describe("authentication form validation", () => {
  it("normalizes a valid sign-in email", () => {
    const result = signInSchema.safeParse({
      email: "  member@example.com  ",
      password: "strong-password",
    });

    assert.strictEqual(result.success, true);
    if (result.success) {
      assert.strictEqual(result.data.email, "member@example.com");
    }
  });

  it("rejects mismatched sign-up passwords", () => {
    const result = signUpSchema.safeParse({
      email: "member@example.com",
      password: "strong-password",
      confirmPassword: "different-password",
    });

    assert.strictEqual(result.success, false);
    if (!result.success) {
      assert.strictEqual(
        result.error.issues.some(
          ({ path }) => path[0] === "confirmPassword",
        ),
        true,
      );
    }
  });
});
