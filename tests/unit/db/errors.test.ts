import { QueryFailedError } from "typeorm";
import { expect, test } from "vitest";

import { DatabaseError, normalizeDatabaseError } from "@/lib/db/errors";

test.each([
  ["23P01", "exclusion_conflict"],
])("normalizes SQLSTATE %s as %s", (code, kind) => {
  const driverError = Object.assign(new Error("Driver detail"), { code });
  const original = new QueryFailedError("SELECT 1", undefined, driverError);
  const normalized = normalizeDatabaseError(original);

  expect(normalized).toBeInstanceOf(DatabaseError);
  expect(normalized.kind).toBe(kind);
  expect(normalized.sqlState).toBe(code);
  expect(normalized.driverMessage).toBe("Driver detail");
  expect(normalized.cause).toBe(original);
  expect(normalized.message).toBe("Database operation failed.");
});

test("preserves structured PostgreSQL constraint and detail only from a TypeORM driver error", () => {
  const original = new QueryFailedError("UPDATE courts", undefined,
    Object.assign(new Error("Foreign key violation"), {
      code: "23503", constraint: "pricing_court_fk", detail: "Internal database detail",
    }));
  const normalized = normalizeDatabaseError(original);
  expect(normalized.constraint).toBe("pricing_court_fk");
  expect(normalized.detail).toBe("Internal database detail");
  expect(normalized.message).toBe("Database operation failed.");
  expect(normalized.cause).toBe(original);
  const arbitrary = normalizeDatabaseError({ code: "23503", constraint: "pricing_court_fk", detail: "spoof" });
  expect(arbitrary.constraint).toBeUndefined();
  expect(arbitrary.detail).toBeUndefined();
});

test.each([
  Object.assign(new Error("Not a TypeORM failure"), { code: "23505" }),
])("does not falsely classify a non-TypeORM error (%s)", (original) => {
  const normalized = normalizeDatabaseError(original);

  expect(normalized.kind).toBe("unknown");
  expect(normalized.sqlState).toBeUndefined();
  expect(normalized.driverMessage).toBeUndefined();
  expect(normalized.cause).toBe(original);
});
