import "server-only";

import type { EntityManager } from "typeorm";

import { z } from "zod";
import { UserEntity } from "../entities/user.entity";
import { RoleEntity } from "../entities/role.entity";

import { UserRoleEntity } from "../entities/user-role.entity";

export async function assignUserRole(
  manager: EntityManager,
  userId: string,
  roleCode: string,
  assignedBy: string,
): Promise<void> {
  const result = await manager.createQueryBuilder()
    .insert()
    .into(UserRoleEntity)
    .values({ userId, roleCode, assignedBy })
    // TypeORM emits DO NOTHING when the overwrite list is empty.
    .orUpdate([], ["user_id", "role_code"])
    .returning("user_id")
    .updateEntity(false)
    .execute();
  if (z.array(z.object({ user_id: z.uuid() })).parse(result.raw).length) await touchRoleUser(manager, userId);
}

export async function removeUserRole(
  manager: EntityManager,
  userId: string,
  roleCode: string,
): Promise<void> {
  const result = await manager.getRepository(UserRoleEntity).delete({ userId, roleCode });
  if (result.affected) await touchRoleUser(manager, userId);
}

export async function listUserRoleCodes(
  manager: EntityManager,
  userId: string,
): Promise<string[]> {
  const assignments = await manager.getRepository(UserRoleEntity).find({
    where: { userId },
    select: { roleCode: true },
    order: { roleCode: "ASC" },
  });
  return assignments.map((assignment) => assignment.roleCode);
}

async function touchRoleUser(manager: EntityManager, userId: string) {
  await manager.getRepository(UserEntity).update({ id: userId }, { updatedAt: () => "now()" });
}

// Every role/status command takes this mutex before actor or target row locks.
export async function lockAdminRole(manager: EntityManager): Promise<void> {
  const role = await manager.getRepository(RoleEntity).findOne({
    where: { code: "admin" }, lock: { mode: "pessimistic_write" },
  });
  if (!role) throw new Error("Administrator role is missing.");
}

export async function lockUserIdentityFacts(manager: EntityManager, userId: string) {
  const roles = await manager.getRepository(UserRoleEntity).createQueryBuilder("role")
    .where({ userId }).orderBy("role.roleCode", "ASC").setLock("pessimistic_write").getMany();
  const user = await manager.getRepository(UserEntity).findOne({
    where: { id: userId }, select: { id: true, status: true }, lock: { mode: "pessimistic_write" },
  });
  return user ? { status: user.status, roles: roles.map((row) => row.roleCode) } : null;
}

export async function countActiveAdmins(manager: EntityManager): Promise<number> {
  const rows: unknown = await manager.query(`SELECT count(*)::integer AS count
    FROM public.users u JOIN public.user_roles r ON r.user_id=u.id
    WHERE u.status='active' AND r.role_code='admin'`);
  return z.array(z.object({ count: z.number().int() })).length(1).parse(rows)[0].count;
}
