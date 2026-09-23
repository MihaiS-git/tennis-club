import assert from "node:assert/strict";
import test from "node:test";

import {
  readFlashMessages,
  removeConsumedFlashMessages,
} from "../../src/lib/flash-messages.ts";

test("query flash values are consumed while unrelated parameters are preserved", () => {
  const params = new URLSearchParams(
    "next=%2Faccount&filter=upcoming&message=Confirmed&error=Expired",
  );

  assert.deepEqual(readFlashMessages(params), [
    { kind: "success", text: "Confirmed" },
    { kind: "error", text: "Expired" },
  ]);
  assert.equal(
    removeConsumedFlashMessages(params),
    "next=%2Faccount&filter=upcoming",
  );
});
