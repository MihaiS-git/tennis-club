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
it("defines four deterministic active users without a member role", () => {
  expect(devUsers.map((user) => user.email)).toEqual([
    "dev-admin@example.test", "dev-coach@example.test",
    "dev-player-001@example.test", "dev-player-002@example.test",
  ]);
  expect(devUsers.map((user) => user.roles)).toEqual([["admin"], ["coach"], [], []]);
});
