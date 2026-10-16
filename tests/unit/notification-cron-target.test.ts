import { expect, test, vi } from "vitest";
import { target, verifyTarget } from "../../scripts/configure-notification-cron";

const local = { NODE_ENV: "test", DATABASE_URL: "postgresql://postgres:placeholder@localhost:54322/postgres", SUPABASE_URL: "http://127.0.0.1:54321" } satisfies NodeJS.ProcessEnv;
const hosted = { NODE_ENV: "test", DATABASE_URL: "postgresql://postgres:placeholder@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require",
  SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" } satisfies NodeJS.ProcessEnv;

test.each([
  "postgresql://postgres@127.0.0.1:54322/postgres?port=55322",
  "postgresql://postgres@127.0.0.1:54322/postgres?host=supabase_db_tennis-club-tests",
  "postgresql://postgres@supabase_db_tennis-club-tests:5432/postgres",
  "postgresql://postgres@127.0.0.1:55322/postgres",
  "postgresql://postgres@127.0.0.1:55329/postgres",
  "postgresql://postgres@127.0.0.1:54322/postgres?dbname=other",
  "postgresql://postgres@127.0.0.1:54322/postgres?options=-csearch_path%3Dother",
  "postgresql://postgres@127.0.0.1:54322/postgres?sslmode=disable",
])("Cron refuses ambiguous or test database URL %s before connecting", DATABASE_URL => {
  expect(() => target({ ...local, DATABASE_URL })).toThrow();
});

test("Cron normalizes safe local and matching direct hosted connections", () => {
  expect(target(local).href).toBe("postgresql://postgres:placeholder@127.0.0.1:54322/postgres");
  expect(target(hosted).href).toBe("postgresql://postgres:placeholder@db.abcdefghijklmnopqrst.supabase.co:5432/postgres");
  expect(target({ ...local, CRON_DATABASE_URL: "" }).href).toBe(target(local).href);
});

test.each([
  { ...local, SUPABASE_URL: hosted.SUPABASE_URL },
  { ...hosted, SUPABASE_URL: "https://anotherproject.supabase.co" },
  { ...hosted, SUPABASE_URL: undefined },
  { ...local, TEST_SUPABASE_PROJECT: "tennis-club-tests" },
  { ...local, PGOPTIONS: "-c search_path=other" },
  { ...hosted, DATABASE_URL: "postgresql://postgres@unverified.example:5432/postgres" },
])("Cron fails closed for an unverified project: %j", env => {
  expect(() => target(env)).toThrow();
});

const identity = { database: "postgres", actor: "postgres", supabase: true };
test("Cron verifies the local server system identity before mutation", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [{ id: "12345" }] });
  await expect(verifyTarget({ query }, target(local), () => "12345")).resolves.toBeUndefined();
  expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});

test.each(["98765", ""])("Cron rejects a forwarded or unknown local server (%s)", actual => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [identity] }).mockResolvedValueOnce({ rows: [{ id: actual }] });
  return expect(verifyTarget({ query }, target(local), () => "12345")).rejects.toThrow("not the verified development");
});

test("Cron verifies hosted database identity and never consults local Docker", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [identity] }), docker = vi.fn();
  await expect(verifyTarget({ query }, target(hosted), docker)).resolves.toBeUndefined();
  expect(docker).not.toHaveBeenCalled();
  query.mockResolvedValue({ rows: [{ ...identity, supabase: false }] });
  await expect(verifyTarget({ query }, target(hosted), docker)).rejects.toThrow("database identity");
});
