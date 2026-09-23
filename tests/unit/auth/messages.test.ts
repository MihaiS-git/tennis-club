import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authErrors, getAuthErrorCode, readAuthNotice } from "../../../src/lib/auth/messages";

describe("authentication messages", () => {
  it("maps sign-in credential errors without revealing account existence", () => {
    assert.equal(
      getAuthErrorCode("signin", "invalid_credentials"),
      "invalid-credentials",
    );
    assert.equal(
      getAuthErrorCode("signin", "user_not_found"),
      "invalid-credentials",
    );
  });

  it("maps provider rate limits to a safe retry message", () => {
    assert.equal(
      getAuthErrorCode("signup", "over_email_send_rate_limit"),
      "rate-limited",
    );
  });

  it("does not render arbitrary query-string content", () => {
    assert.equal(readAuthNotice("not-a-real-code", authErrors), undefined);
    assert.equal(
      readAuthNotice("invalid-credentials", authErrors),
      "The email or password is incorrect.",
    );
  });
});
