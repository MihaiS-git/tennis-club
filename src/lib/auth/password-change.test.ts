import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changePasswordWithVerification } from "./password-change";

describe("changePasswordWithVerification", () => {
  it("updates the password only after the current password is verified", async () => {
    let updates = 0;
    const result = await changePasswordWithVerification({
      authenticatedClient: {
        auth: {
          async updateUser({ password }) {
            updates += 1;
            assert.equal(password, "new-password");
            return { error: null };
          },
        },
      },
      verificationClient: {
        auth: {
          async signInWithPassword() {
            return { data: { user: { id: "user-id" } }, error: null };
          },
          async signOut() {
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
    assert.equal(updates, 1);
  });

  it("does not update the password when current-password verification fails", async () => {
    let updates = 0;
    const result = await changePasswordWithVerification({
      authenticatedClient: {
        auth: {
          async updateUser() {
            updates += 1;
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
    assert.equal(updates, 0);
  });
});
