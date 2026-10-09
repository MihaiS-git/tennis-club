import "server-only";

import { QueryFailedError } from "typeorm";

export type DatabaseErrorKind =
  | "unique_violation"
  | "foreign_key_violation"
  | "check_violation"
  | "exclusion_conflict"
  | "serialization_failure"
  | "deadlock"
  | "unknown";

export class DatabaseError extends Error {
  constructor(
    readonly kind: DatabaseErrorKind,
    readonly sqlState: string | undefined,
    cause: unknown,
    readonly driverMessage?: string,
    readonly constraint?: string,
    readonly detail?: string,
  ) {
    super("Database operation failed.", { cause });
    this.name = "DatabaseError";
  }
}

export function normalizeDatabaseError(error: unknown): DatabaseError {
  let sqlState: string | undefined;
  let driverMessage: string | undefined;
  let constraint: string | undefined;
  let detail: string | undefined;
  if (error instanceof QueryFailedError) {
    const driverError: unknown = error.driverError;
    if (typeof driverError === "object" && driverError !== null
      && "code" in driverError && typeof driverError.code === "string") {
      sqlState = driverError.code;
      if ("message" in driverError && typeof driverError.message === "string") {
        driverMessage = driverError.message;
      }
      if ("constraint" in driverError && typeof driverError.constraint === "string") {
        constraint = driverError.constraint;
      }
      if ("detail" in driverError && typeof driverError.detail === "string") {
        detail = driverError.detail;
      }
    }
  }

  let kind: DatabaseErrorKind;
  switch (sqlState) {
    case "23505": kind = "unique_violation"; break;
    case "23503": kind = "foreign_key_violation"; break;
    case "23514": kind = "check_violation"; break;
    case "23P01": kind = "exclusion_conflict"; break;
    case "40001": kind = "serialization_failure"; break;
    case "40P01": kind = "deadlock"; break;
    default: kind = "unknown";
  }
  return new DatabaseError(kind, sqlState, error, driverMessage, constraint, detail);
}
