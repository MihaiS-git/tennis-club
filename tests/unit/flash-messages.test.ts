import { assert, test } from "vitest";

import {
  readFlashMessages,
  removeConsumedFlashMessages,
} from "../../src/lib/flash-messages";

test("known notice is consumed while unrelated parameters are preserved", () => {
  const params = new URLSearchParams(
    "next=%2Faccount&filter=upcoming&notice=password-changed",
  );

  assert.deepStrictEqual(readFlashMessages(params), [
    { kind: "success", text: "Your password has been changed." },
  ]);
  assert.strictEqual(
    removeConsumedFlashMessages(params),
    "next=%2Faccount&filter=upcoming",
  );
});

test("raw message text and unknown notice codes produce no flash", () => {
  assert.deepStrictEqual(readFlashMessages(new URLSearchParams("message=Payment+confirmed")), []);
  assert.deepStrictEqual(readFlashMessages(new URLSearchParams("notice=unknown")), []);
});
