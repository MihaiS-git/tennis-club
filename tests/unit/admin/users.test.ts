import { createClient } from "@supabase/supabase-js";
import { QueryFailedError } from "typeorm";
import { beforeEach, expect, it, vi } from "vitest";

import type { AdminUserPersistenceRow } from "@/lib/db/repositories/users.repository";

const { requireActiveAdmin, getDataSource, countAdminUsers, findAdminUsersPage, findAdminUserById, loadProfile, logError, manager } = vi.hoisted(() => ({
  requireActiveAdmin: vi.fn(),
  getDataSource: vi.fn(),
  countAdminUsers: vi.fn(),
  findAdminUsersPage: vi.fn(),
  findAdminUserById: vi.fn(),
  loadProfile: vi.fn(),
  logError: vi.fn(),
  manager: {},
}));

vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource }));
vi.mock("@/lib/db/repositories/users.repository", () => ({ countAdminUsers, findAdminUsersPage, findAdminUserById }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError } }));

vi.mock("@/lib/profile/profile", () => ({ loadProfile }));

import { listAdminUsers, readAdminUserDetails } from "@/lib/admin/users";

const persistence = [
  {
    user: {
      id: "11111111-1111-4111-8111-111111111111", email: "coach@example.test", status: "active",
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-02-01"),
    },
    roleCodes: ["coach", "admin"],
  },
  {
    user: {
      id: "22222222-2222-4222-8222-222222222222", email: "ordinary@example.test", status: "suspended",
      createdAt: new Date("2026-01-02"), updatedAt: new Date("2026-02-02"),
    },
    roleCodes: [],
  },
] satisfies AdminUserPersistenceRow[];

function clientWithPersistenceSpies() {
  const client = createClient("http://127.0.0.1:54321", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return { client, from: vi.spyOn(client, "from"), rpc: vi.spyOn(client, "rpc") };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireActiveAdmin.mockResolvedValue({ state: "active", userId: persistence[0].user.id, roles: ["admin"] });
  getDataSource.mockResolvedValue({ manager });
  countAdminUsers.mockResolvedValue(2);
  findAdminUsersPage.mockResolvedValue(persistence);
});

it("clamps excessive pages after the exact count, before page persistence", async () => {
  countAdminUsers.mockResolvedValue(41);
  const result = await listAdminUsers({ page: 9999 }, clientWithPersistenceSpies().client);
  expect(result).toMatchObject({ page: 3, pageSize: 20, total: 41, totalPages: 3 });
  expect(findAdminUsersPage).toHaveBeenCalledExactlyOnceWith(manager, {
    search: undefined, status: undefined, role: undefined, page: 9999, sort: "joined", dir: "desc",
  }, 40, 20);
  expect(countAdminUsers.mock.invocationCallOrder[0]).toBeLessThan(findAdminUsersPage.mock.invocationCallOrder[0]);
});

it.each(["page"] as const)("sanitizes %s persistence failure without a PostgREST fallback", async (boundary) => {
  const failure = new QueryFailedError("sensitive SQL", ["private parameter"],
    Object.assign(new Error("postgresql://secret:password@host/database"), { code: "40001" }));
  ({ "data source": getDataSource, count: countAdminUsers, page: findAdminUsersPage }[boundary]).mockRejectedValue(failure);
  const { client, from, rpc } = clientWithPersistenceSpies();
  await expect(listAdminUsers({}, client)).rejects.toThrow(/^Unable to load users\.$/);
  expect(logError).toHaveBeenCalledExactlyOnceWith({ event: "admin.users_list_failed", code: "40001" },
    boundary === "page" ? "Failed to list users" : "Failed to count users");
  if (boundary !== "page") expect(findAdminUsersPage).not.toHaveBeenCalled();
  expect(from).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it("validates the detail target UUID after authorization and before persistence", async () => {
  await expect(readAdminUserDetails("invalid-uuid", clientWithPersistenceSpies().client)).rejects.toThrow("Invalid UUID");
  expect(requireActiveAdmin).toHaveBeenCalledOnce();
  expect(getDataSource).not.toHaveBeenCalled();
  expect(findAdminUserById).not.toHaveBeenCalled();
  expect(loadProfile).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
});
