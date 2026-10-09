import { fileURLToPath } from "node:url";

import { createDataSource } from "./data-source.ts";

// Standalone migration execution uses the same connection settings and entity registry as the application.
// Its Node loader supports TypeScript decorators without initializing Next.js.
export default createDataSource().setOptions({
  migrations: [fileURLToPath(new URL("./migrations/*{.ts,.js}", import.meta.url))],
});
