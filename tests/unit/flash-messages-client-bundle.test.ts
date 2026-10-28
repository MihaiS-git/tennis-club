import { assert, test, vi } from "vitest";

// QueryFlashMessages renders in the root layout on every page, so everything this
// module imports ships in the initial client JavaScript. Validation schemas belong
// to the Server Actions, not to that bundle.
test("flash messages load without the validation library", async () => {
  vi.doMock("zod", () => {
    throw new Error("zod must not be imported by client flash messages");
  });

  const { readFlashMessages } = await import("../../src/lib/flash-messages");

  assert.deepEqual(readFlashMessages(new URLSearchParams("notice=password-changed")), [
    { kind: "success", text: "Your password has been changed." },
  ]);
});
