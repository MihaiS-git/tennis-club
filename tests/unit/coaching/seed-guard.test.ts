import { afterEach, expect, it, vi } from "vitest";

const { getDataSource, createClient } = vi.hoisted(() => ({ getDataSource: vi.fn(), createClient: vi.fn() }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

import { demoCoaches, demoPrograms, seedDevCoaching } from "../../../scripts/seed-dev-coaching";

const local = { NODE_ENV: "development", SUPABASE_URL: "http://127.0.0.1:54321", DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres" };

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it.each([
  { ...local, NODE_ENV: "production" },
  { ...local, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" },
  { ...local, DATABASE_URL: "postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres" },
  // The isolated integration-test database is not a development target either.
  { ...local, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55322/postgres" },
  { ...local, DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=elsewhere" },
])("refuses to seed outside the local development stack before any Auth or database access: %j", async (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  await expect(seedDevCoaching()).rejects.toThrow(/Development initialization requires/);
  expect(createClient).not.toHaveBeenCalled();
  expect(getDataSource).not.toHaveBeenCalled();
});

it("defines the four program types and demo coaches on example.test accounts only", () => {
  expect(demoPrograms.map((program) => program.type)).toEqual(["private", "semi_private", "group", "junior"]);
  expect(new Set(demoPrograms.map((program) => program.id)).size).toBe(demoPrograms.length);
  expect(demoCoaches.length).toBeGreaterThanOrEqual(3);
  for (const coach of demoCoaches) {
    expect(coach.email).toMatch(/^demo-coach-[a-z]+@example\.test$/);
    expect(coach.programIds.every((id) => demoPrograms.some((program) => program.id === id))).toBe(true);
  }
});
