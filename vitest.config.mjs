import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Tests must opt into mocked mail configuration; never inherit a real provider key.
  test: { setupFiles: ["./tests/local/guard.ts"], env: { BREVO_API_KEY: "", BOOKING_MAIL_FROM: "" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only.ts", import.meta.url)),
    },
  },
});
