import "server-only";

import { In, type EntityManager } from "typeorm";
import { z } from "zod";

import type { AdminUserFilters } from "@/lib/admin/users-filters";
import { UserRoleEntity } from "../entities/user-role.entity";
import { UserEntity } from "../entities/user.entity";
import { listUserRoleCodes } from "./user-roles.repository";

export type PersonalInformationPersistence = Pick<UserEntity,
  "firstName" | "lastName" | "phone" | "dateOfBirth" | "addressLine1" |
  "addressLine2" | "city" | "postalCode" | "countryCode"
>;

export type PersonalInformationPersistenceInput = PersonalInformationPersistence;

export async function updatePersonalInformation(
  manager: EntityManager,
  userId: string,
  fields: PersonalInformationPersistenceInput,
): Promise<boolean> {
  const result = await manager.createQueryBuilder()
    .update(UserEntity)
    .set({
      firstName: fields.firstName, lastName: fields.lastName, phone: fields.phone,
      dateOfBirth: fields.dateOfBirth, addressLine1: fields.addressLine1,
      addressLine2: fields.addressLine2, city: fields.city,
      postalCode: fields.postalCode, countryCode: fields.countryCode, updatedAt: () => "now()",
    })
    .where({ id: userId, status: "active" })
    .updateEntity(false)
    .execute();
  return result.affected === 1;
}

export async function findPersonalInformationByUserId(
  manager: EntityManager,
  userId: string,
): Promise<PersonalInformationPersistence | null> {
  const user = await manager.getRepository(UserEntity).findOne({
    where: { id: userId },
    select: {
      // A non-null selected identity keeps an all-null personal row hydratable.
      // The returned persistence projection still contains only personal fields.
      id: true,
      firstName: true, lastName: true, phone: true, dateOfBirth: true,
      addressLine1: true, addressLine2: true, city: true, postalCode: true, countryCode: true,
    },
  });
  if (!user) return null;

  return {
    firstName: user.firstName, lastName: user.lastName, phone: user.phone,
    dateOfBirth: user.dateOfBirth, addressLine1: user.addressLine1, addressLine2: user.addressLine2,
    city: user.city, postalCode: user.postalCode, countryCode: user.countryCode,
  };
}

export type AdminUserPersistenceRow = {
  user: Pick<UserEntity, "id" | "email" | "status" | "createdAt" | "updatedAt">;
  roleCodes: string[];
};

export async function findAdminUserById(
  manager: EntityManager,
  userId: string,
): Promise<AdminUserPersistenceRow | null> {
  const user = await manager.getRepository(UserEntity).findOne({
    where: { id: userId },
    select: { id: true, email: true, status: true, createdAt: true, updatedAt: true },
  });
  if (!user) return null;

  const roleCodes = await listUserRoleCodes(manager, userId);
  return {
    user: {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    roleCodes,
  };
}

function adminUsersQuery(manager: EntityManager, filters: AdminUserFilters) {
  const query = manager.getRepository(UserEntity).createQueryBuilder("users");
  if (filters.search) {
    // Match PostgREST imatch's PostgreSQL regex, with every metacharacter escaped.
    // Percent, underscore and star remain literal substring input, never LIKE wildcards.
    const literal = filters.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.andWhere("users.email ~* :search", { search: literal });
  }
  if (filters.status) query.andWhere("users.status = :status", { status: filters.status });
  if (filters.role) {
    const roleFilter = query.subQuery().select("1").from(UserRoleEntity, "role_filter")
      .where("role_filter.userId = users.id")
      .andWhere("role_filter.roleCode = :role").getQuery();
    query.andWhere(`EXISTS ${roleFilter}`, { role: filters.role });
  }
  return query;
}

export async function countAdminUsers(
  manager: EntityManager,
  filters: AdminUserFilters,
): Promise<number> {
  return adminUsersQuery(manager, filters).getCount();
}

export async function findAdminUsersPage(
  manager: EntityManager,
  filters: AdminUserFilters,
  offset: number,
  limit: number,
): Promise<AdminUserPersistenceRow[]> {
  const query = adminUsersQuery(manager, filters)
    .select(["users.id", "users.email", "users.status", "users.createdAt", "users.updatedAt"]);
  const sortColumn = { email: "users.email", status: "users.status", joined: "users.createdAt", roles: "role_sort_key" }[filters.sort];
  if (filters.sort === "roles") {
    // Deterministic additive role sort key: normal=0, coach=1, Admin=2, both=3.
    query.addSelect((subquery) => subquery
      .select("COALESCE(SUM(CASE role_sort.roleCode WHEN 'admin' THEN 2 WHEN 'coach' THEN 1 ELSE 0 END), 0)::integer")
      .from(UserRoleEntity, "role_sort")
      .where("role_sort.userId = users.id"), "role_sort_key");
  }
  const direction = filters.dir === "asc" ? "ASC" : "DESC";
  const users = await query.orderBy(sortColumn, direction).addOrderBy("users.id", direction)
    .offset(offset).limit(limit).getMany();
  if (users.length === 0) return [];

  const assignments = await manager.getRepository(UserRoleEntity).find({
    where: { userId: In(users.map((user) => user.id)) },
    select: { userId: true, roleCode: true },
    order: { roleCode: "ASC" },
  });
  const rolesByUser = new Map<string, string[]>();
  for (const assignment of assignments) {
    const roles = rolesByUser.get(assignment.userId) ?? [];
    roles.push(assignment.roleCode);
    rolesByUser.set(assignment.userId, roles);
  }
  return users.map((user) => ({ user, roleCodes: rolesByUser.get(user.id) ?? [] }));
}

const updatedUserStatusSchema = z.object({
  id: z.uuid(),
  status: z.enum(["active", "suspended"]),
});

export async function updateUserStatus(
  manager: EntityManager,
  userId: string,
  status: UserEntity["status"],
): Promise<Pick<UserEntity, "id" | "status"> | null> {
  const result = await manager.createQueryBuilder()
    .update(UserEntity)
    .set({ status, updatedAt: () => "now()" })
    .where({ id: userId })
    .returning(["id", "status"])
    .updateEntity(false)
    .execute();

  const rows = updatedUserStatusSchema.array().max(1).parse(result.raw);
  return rows[0] ?? null;
}
