import { expect, it } from "vitest";
import { devUsers, localSupabaseUrl } from "../../scripts/seed-dev-users";

it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321"])("accepts local origin %s", (origin) => {
  expect(localSupabaseUrl(origin, "development")).toContain(":54321");
  expect(localSupabaseUrl(`${origin}/`, undefined)).toContain(":54321");
});
it.each([
  undefined, "", "https://example.supabase.co", "http://127.0.0.1:3000",
  "https://localhost:54321", "http://localhost:54321.evil.test",
  "http://localhost.evil.test:54321", "http://user:password@localhost:54321",
  "http://127.0.0.1:54321/rest/v1", "http://127.0.0.1:54321?host=remote", "http://127.0.0.1:54321#remote",
])("rejects unsafe origin %s", (origin) => {
  expect(() => localSupabaseUrl(origin, "development")).toThrow("local Supabase");
});
it("rejects production mode even with a local URL", () => {
  expect(() => localSupabaseUrl("http://127.0.0.1:54321", "production")).toThrow();
});
it("creates deterministic fixture specifications with all four role combinations", () => {
  expect(devUsers).toHaveLength(60);
  expect(new Set(devUsers.map((user) => user.email)).size).toBe(60);
  expect(devUsers[0].email).toBe("dev-user-001@example.test");
  expect(devUsers[59].email).toBe("dev-user-060@example.test");
  expect(devUsers.filter((user) => user.roles.length === 0)).toHaveLength(48);
  expect(devUsers.filter((user) => user.roles.includes("coach"))).toHaveLength(9);
  expect(devUsers.filter((user) => user.roles.includes("admin"))).toHaveLength(6);
  expect(devUsers.filter((user) => user.roles.length === 2)).toHaveLength(3);
  expect(devUsers.filter((user) => user.status === "suspended")).toHaveLength(8);
  expect(devUsers.filter((user) => user.roles.includes("admin")).every((user) => user.status === "active")).toBe(true);
});
