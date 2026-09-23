import { assert, describe, it } from "vitest";

import { authErrors, getAuthErrorCode, readAuthNotice } from "../../../src/lib/auth/messages";

describe("authentication messages", () => {
  it("maps sign-in credential errors without revealing account existence", () => {
    assert.strictEqual(
      getAuthErrorCode("signin", "invalid_credentials"),
      "invalid-credentials",
    );
    assert.strictEqual(
      getAuthErrorCode("signin", "user_not_found"),
      "invalid-credentials",
    );
  });

  it("maps provider rate limits to a safe retry message", () => {
    assert.strictEqual(
      getAuthErrorCode("signup", "over_email_send_rate_limit"),
      "rate-limited",
    );
  });

  it("does not render arbitrary query-string content", () => {
    assert.strictEqual(readAuthNotice("not-a-real-code", authErrors), undefined);
    assert.strictEqual(
      readAuthNotice("invalid-credentials", authErrors),
      "The email or password is incorrect.",
    );
  });
});
