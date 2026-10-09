// Development fixtures only. Never imported by application code.
import { pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDataSource } from "../src/lib/db/data-source.ts";
import { UserEntity } from "../src/lib/db/entities/user.entity.ts";
import { UserRoleEntity } from "../src/lib/db/entities/user-role.entity.ts";
import { assertLocalDatabase, localAuthClient } from "./local-dev.ts";
import { seedDevData } from "./seed-dev-data.ts";

const DEV_USER_PASSWORD = "Local-Tennis-Dev-2026!";

const devUsers = [
  { email: "dev-admin@example.test", roles: ["admin"] },
  { email: "dev-coach@example.test", roles: ["coach"] },
  ...Array.from({ length: 8 }, (_, index) => ({
    email: `dev-coach-${String(index + 2).padStart(3, "0")}@example.test`, roles: ["coach"],
  })),
  ...Array.from({ length: 90 }, (_, index) => ({
    email: `dev-player-${String(index + 1).padStart(3, "0")}@example.test`, roles: [],
  })),
];

async function seedDevUsers(service: SupabaseClient) {
  assertLocalDatabase();
  const database = await getDataSource();
  // Read Auth once (paginated), including accounts without an application row.
  const existing = new Set<string>();
  for (let page = 1; ; page += 1) {
    const result = await service.auth.admin.listUsers({ page, perPage: 1000 });
    if (result.error) throw new Error("Unable to list local Auth accounts.");
    for (const user of result.data.users) {
      if (user.email) existing.add(user.email.toLowerCase());
    }
    if (result.data.users.length < 1000) break;
  }

  const created: string[] = [];
  let reused = 0;
  for (const fixture of devUsers) {
    if (existing.has(fixture.email)) {
      // Existing accounts are never updated, even if their fixture data differs.
      reused += 1;
      continue;
    }
    const result = await service.auth.admin.createUser({
      email: fixture.email,
      password: DEV_USER_PASSWORD,
      email_confirm: true,
    });
    if (result.error || !result.data.user) {
      throw new Error(`Unable to create ${fixture.email}. Earlier fixtures may already exist; rerunning skips them.`);
    }
    const id = result.data.user.id;
    created.push(id);
  }

  // Repair an interrupted role assignment on rerun, without changing existing accounts.
  await database.transaction("READ COMMITTED", async (manager) => {
    for (const fixture of devUsers) {
      const account = await manager.findOneBy(UserEntity, { email: fixture.email });
      if (!account || account.status !== "active") {
        throw new Error(`Expected an active provisioned account for ${fixture.email}.`);
      }
      for (const roleCode of fixture.roles) {
        await manager.createQueryBuilder().insert().into(UserRoleEntity)
          .values({ userId: account.id, roleCode, assignedAt: new Date(), assignedBy: null })
          .orIgnore().execute();
      }
      const roles = await manager.findBy(UserRoleEntity, { userId: account.id });
      if (roles.map((role) => role.roleCode).sort().join(",") !== fixture.roles.join(",")) {
        throw new Error(`Unexpected roles for ${fixture.email}; inspect the local fixture.`);
      }
    }
  });
  console.log(JSON.stringify({
    created: created.length, reused, verified: devUsers.length,
    roles: {
      noRoles: devUsers.filter((user) => user.roles.length === 0).length,
      coach: devUsers.filter((user) => user.roles.includes("coach")).length,
      admin: devUsers.filter((user) => user.roles.includes("admin")).length,
    },
  }, null, 2));
}

async function main() {
  const service = localAuthClient();
  const database = await getDataSource();
  try {
    await seedDevUsers(service);
    if (!process.argv.includes("--users-only")) await seedDevData();
  } finally {
    await database.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Development user seeding failed.");
    process.exitCode = 1;
  });
}
