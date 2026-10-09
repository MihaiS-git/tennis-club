import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";

import { UserRoleEntity } from "../entities/user-role.entity";
import { UserEntity } from "../entities/user.entity";

// Preserve the command-time actor fence while the configuration transaction runs.
export async function lockActiveAdminAccount(manager: EntityManager, userId: string): Promise<boolean> {
  const facts = await lockReservationActorFacts(manager, userId);
  return facts?.status === "active" && facts.roles.includes("admin");
}

export type AccountPersistence = {
  user: Pick<UserEntity,
    "id" | "email" | "status" | "phone" | "dateOfBirth" | "countryCode" | "createdAt" | "updatedAt"
  >;
  roleCodes: string[];
};

export async function findAccountById(
  manager: EntityManager,
  userId: string,
): Promise<AccountPersistence | null> {
  const user = await manager.getRepository(UserEntity).findOne({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      status: true,
      phone: true,
      dateOfBirth: true,
      countryCode: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!user) return null;

  const assignments = await manager.getRepository(UserRoleEntity).find({
    where: { userId },
    select: { roleCode: true },
    order: { roleCode: "ASC" },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      status: user.status,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      countryCode: user.countryCode,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    roleCodes: assignments.map((assignment) => assignment.roleCode),
  };
}

// Role deletion locks its assignment before its trigger touches the account.
// Return facts only; the reservation service decides staff/Admin eligibility.
export async function lockReservationActorFacts(manager: EntityManager, userId: string) {
  const assignments: unknown = await manager.query(
    `SELECT role_code FROM public.user_roles
     WHERE user_id = $1 AND role_code IN ('admin', 'coach')
     ORDER BY role_code FOR SHARE`, [userId],
  );
  const accounts: unknown = await manager.query(
    "SELECT status FROM public.users WHERE id = $1 FOR SHARE", [userId],
  );
  const roles = z.array(z.object({ role_code: z.enum(["admin", "coach"]) })).parse(assignments);
  const account = z.array(z.object({ status: z.enum(["active", "suspended"]) })).max(1).parse(accounts)[0];
  return account ? { status: account.status, roles: roles.map((row) => row.role_code) } : null;
}

// Customer checkout needs account status only, with no role-assignment fence.
export async function lockCheckoutAccountStatus(manager: EntityManager, userId: string) {
  const rows: unknown = await manager.query("SELECT status FROM public.users WHERE id=$1 FOR SHARE", [userId]);
  return z.array(z.object({ status: z.enum(["active", "suspended"]) })).max(1).parse(rows)[0] ?? null;
}
