// Destructive, explicitly invoked local development initialization only.
import { createInterface } from "node:readline/promises";
import { getDataSource } from "../src/lib/db/data-source.ts";
import migrationDataSource from "../src/lib/db/migration-data-source.mjs";
import {
  assertLocalDatabase,
  localAuthClient,
  localStatus,
} from "./local-dev.ts";

async function main() {
  assertLocalDatabase();
  const status = localStatus();
  const localDb = new URL(status.DB_URL);
  const target = new URL(process.env.DATABASE_URL!);
  if (
    localDb.hostname !== target.hostname ||
    localDb.port !== target.port ||
    localDb.pathname !== target.pathname ||
    status.API_URL !== "http://127.0.0.1:54321"
  ) {
    throw new Error(
      "Configured database/API do not match this project's running local Supabase stack.",
    );
  }
  const service = localAuthClient();
  const database = await getDataSource();
  try {
    const identity = await database.query(
      "SELECT current_database() AS database, current_user AS actor",
    );
    if (
      identity[0]?.database !== "postgres" ||
      identity[0]?.actor !== "postgres"
    )
      throw new Error("Unexpected database identity.");
    const extensions =
      await database.query(`SELECT extname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
      WHERE n.nspname='public'`);
    if (extensions.length)
      throw new Error(
        "Refusing to discard public schema containing infrastructure extensions.",
      );
    console.log(
      "Verified local Supabase API 127.0.0.1:54321 and postgres database 127.0.0.1:54322.",
    );
    console.warn(
      "WARNING: All local application data, Supabase Auth users and avatars will be deleted.",
    );
    if (!process.argv.includes("--discard-local-data")) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          "Non-interactive rebuild requires the explicit --discard-local-data flag.",
        );
      }
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await prompt.question(
          "Rebuild the development database? (y/N): ",
        );
        if (answer !== "y") {
          console.log("Development database rebuild cancelled.");
          return;
        }
      } finally {
        prompt.close();
      }
    }

    const buckets = await service.storage.listBuckets();
    if (buckets.error)
      throw new Error("Unable to inspect local Storage buckets.");
    if (buckets.data.some((bucket) => bucket.id === "profile-avatars")) {
      if ((await service.storage.emptyBucket("profile-avatars")).error)
        throw new Error("Unable to empty local avatars.");
      if ((await service.storage.deleteBucket("profile-avatars")).error)
        throw new Error("Unable to remove local avatar bucket.");
    }

    await database.transaction(async (manager) => {
      // CASCADE also removes application-owned Auth hooks and Storage policies.
      // Native auth/storage/extensions schemas and their migration ledgers survive.
      await manager.query("DROP SCHEMA public CASCADE");
      await manager.query(
        "CREATE SCHEMA public AUTHORIZATION pg_database_owner",
      );
      await manager.query("GRANT USAGE ON SCHEMA public TO PUBLIC");
      await manager.query(
        "GRANT ALL ON SCHEMA public TO postgres, service_role",
      );
      // Retain the privileged local fixture path; browser grants are denied by migrations.
      await manager.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role",
      );
      await manager.query(
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role",
      );
      await manager.query("DROP SCHEMA IF EXISTS supabase_migrations CASCADE");
    });
    // With obsolete application FKs/hooks removed, Auth owns deletion of its users.
    for (;;) {
      const result = await service.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      if (result.error)
        throw new Error("Unable to list local Auth users for deletion.");
      if (!result.data.users.length) break;
      for (const user of result.data.users) {
        if ((await service.auth.admin.deleteUser(user.id)).error)
          throw new Error("Unable to discard a local Auth user.");
      }
    }
    await migrationDataSource.initialize();
    try {
      const applied = await migrationDataSource.runMigrations({
        transaction: "all",
      });
      console.log(
        "Applied migrations:",
        applied.map((migration) => migration.name).join(", "),
      );
    } finally {
      await migrationDataSource.destroy();
    }
    await database.query("NOTIFY pgrst, 'reload schema'");
    console.log("Local development database rebuilt.");
  } finally {
    await database.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Local database rebuild failed.",
  );
  process.exitCode = 1;
});
