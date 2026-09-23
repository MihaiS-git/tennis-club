import { assert, test } from "vitest";

import {
  readFlashMessages,
  removeConsumedFlashMessages,
} from "../../src/lib/flash-messages";

test("query flash values are consumed while unrelated parameters are preserved", () => {
  const params = new URLSearchParams(
    "next=%2Faccount&filter=upcoming&message=Confirmed&error=Expired",
  );

  assert.deepStrictEqual(readFlashMessages(params), [
    { kind: "success", text: "Confirmed" },
    { kind: "error", text: "Expired" },
  ]);
  assert.strictEqual(
    removeConsumedFlashMessages(params),
    "next=%2Faccount&filter=upcoming",
  );
});
