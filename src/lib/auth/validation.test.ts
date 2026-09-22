import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseSignInForm, parseSignUpForm } from "./validation";

function validSignUpForm() {
  const formData = new FormData();
  formData.set("email", "member@example.com");
  formData.set("password", "strong-password");
  formData.set("confirmPassword", "strong-password");

  return formData;
}

describe("authentication form validation", () => {
  it("normalizes a valid sign-in email", () => {
    const formData = new FormData();
    formData.set("email", "  member@example.com  ");
    formData.set("password", "strong-password");

    const result = parseSignInForm(formData);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.email, "member@example.com");
    }
  });

  it("rejects invalid sign-up input and mismatched passwords", () => {
    const formData = validSignUpForm();
    formData.set("confirmPassword", "different-password");

    const result = parseSignUpForm(formData);

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

  it("does not accept a caller-provided role as auth input", () => {
    const formData = validSignUpForm();
    formData.set("role", "admin");

    const result = parseSignUpForm(formData);

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal("role" in result.data, false);
    }
  });
});
