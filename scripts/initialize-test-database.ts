import { configureTestEnvironment, assertTestEnvironment } from "../tests/local/environment.mjs";

configureTestEnvironment();
assertTestEnvironment();
// Import after resolving the isolated URL: the migration DataSource is module-scoped.
const { default: database } = await import("../src/lib/db/migration-data-source.mjs");
await database.initialize();
try {
  const [identity] = await database.query("SELECT current_database() AS database, current_user AS actor");
  if (identity?.database !== "postgres" || identity?.actor !== "postgres") {
    throw new Error("Unexpected test database identity.");
  }
  const applied = await database.runMigrations({ transaction: "all" });
  if (await database.showMigrations()) throw new Error("Test migrations remain pending.");
  await database.query("NOTIFY pgrst, 'reload schema'");
  console.log(`Verified isolated test database at 127.0.0.1:55322; applied ${applied.length} registered TypeORM migrations. No development seeds run.`);
} finally {
  await database.destroy();
}
