import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { assertTestEnvironment } from "../local/environment.mjs";

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55322/postgres");
  vi.stubEnv("LOCAL_SUPABASE_DB_URL", process.env.DATABASE_URL!);
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:55321");
  vi.stubEnv("MAILPIT_URL", "http://127.0.0.1:55324");
  vi.stubEnv("TEST_SUPABASE_PROJECT", "tennis-club-tests");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-anon-key");
  vi.stubEnv("LOCAL_SUPABASE_SERVICE_ROLE_KEY", "test-service-key");
});

afterEach(() => vi.unstubAllEnvs());

test("accepts only the complete isolated test connection settings", () => {
  expect(() => assertTestEnvironment()).not.toThrow();
});

test.each([
  ["DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"],
  ["DATABASE_URL", "postgresql://postgres:postgres@db.example.com:55322/postgres"],
  ["DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55322/development"],
  ["DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:55322/postgres?host=127.0.0.1&port=54322"],
  ["LOCAL_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"],
  ["SUPABASE_URL", "http://127.0.0.1:54321"],
  ["SUPABASE_URL", "https://project.supabase.co"],
  ["MAILPIT_URL", "http://127.0.0.1:54324"],
  ["TEST_SUPABASE_PROJECT", "tennis-club"],
  ["LOCAL_SUPABASE_SERVICE_ROLE_KEY", ""],
])("rejects unsafe %s = %s before any connection", (name, value) => {
  vi.stubEnv(name, value);
  expect(() => assertTestEnvironment()).toThrow();
});
