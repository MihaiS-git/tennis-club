import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { signInSchema, signUpSchema } from "../../../src/lib/auth/validation";

describe("authentication form validation", () => {
  it("normalizes a valid sign-in email", () => {
    const result = signInSchema.safeParse({
      email: "  member@example.com  ",
      password: "strong-password",
    });

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.email, "member@example.com");
    }
  });

  it("rejects mismatched sign-up passwords", () => {
    const result = signUpSchema.safeParse({
      email: "member@example.com",
      password: "strong-password",
      confirmPassword: "different-password",
    });

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(
        result.error.issues.some(
          ({ path }) => path[0] === "confirmPassword",
        ),
        true,
      );
    }
  });
});
