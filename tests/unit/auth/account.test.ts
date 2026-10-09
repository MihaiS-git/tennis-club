import { AuthError, createClient } from "@supabase/supabase-js";
import { QueryFailedError } from "typeorm";
import { beforeEach, expect, it, vi } from "vitest";

import type { AccountPersistence } from "@/lib/db/repositories/accounts.repository";

const { getDataSource, findAccountById, logError, manager } = vi.hoisted(() => ({
  getDataSource: vi.fn(),
  findAccountById: vi.fn(),
  logError: vi.fn(),
  manager: {},
}));

vi.mock("@/lib/db/data-source", () => ({ getDataSource }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ findAccountById }));
vi.mock("@/lib/logger", () => ({ logger: { error: logError } }));

import { readCurrentAccount } from "@/lib/auth/account";

const authId = "11111111-1111-4111-8111-111111111111";
const persistence = {
  user: {
    id: authId,
    email: "account@example.test",
    status: "active",
    phone: null,
    dateOfBirth: null,
    countryCode: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  },
  roleCodes: ["admin", "coach"],
} satisfies AccountPersistence;

function authClient() {
  const client = createClient("http://127.0.0.1:54321", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const getUser = vi.fn().mockResolvedValue({
    data: {
      user: {
        id: authId, app_metadata: {}, user_metadata: {}, aud: "authenticated",
        created_at: "2026-01-01T00:00:00Z",
      },
    },
    error: null,
  });
  vi.spyOn(client.auth, "getUser").mockImplementation(getUser);
  const from = vi.spyOn(client, "from");
  const rpc = vi.spyOn(client, "rpc");
  return { client, getUser, from, rpc };
}

beforeEach(() => {
  vi.resetAllMocks();
  getDataSource.mockResolvedValue({ manager });
  findAccountById.mockResolvedValue(persistence);
});

it.each(["active", "suspended"] as const)("maps a %s account using only the Auth UUID", async (status) => {
  const { client, getUser, from, rpc } = authClient();
  findAccountById.mockResolvedValue({
    ...persistence,
    user: { ...persistence.user, id: "persistence-id-must-not-be-used", status },
  });

  await expect(readCurrentAccount(client)).resolves.toEqual({
    state: status, userId: authId, email: persistence.user.email, roles: ["admin", "coach"],
  });
  expect(getUser).toHaveBeenCalledExactlyOnceWith();
  expect(getDataSource).toHaveBeenCalledExactlyOnceWith();
  expect(findAccountById).toHaveBeenCalledExactlyOnceWith(manager, authId);
  expect(from).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

it.each(["auth error"])("skips persistence on %s", async (scenario) => {
  const { client, getUser } = authClient();
  if (scenario === "missing user") {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
  } else {
    getUser.mockResolvedValue({
      ...(await getUser()),
      error: new AuthError("Auth failed"),
    });
    getUser.mockClear();
  }
  await expect(readCurrentAccount(client)).resolves.toEqual({ state: "unauthenticated" });
  expect(getDataSource).not.toHaveBeenCalled();
  expect(findAccountById).not.toHaveBeenCalled();
  expect(logError).not.toHaveBeenCalled();
});

it("returns missing-profile when the account is absent", async () => {
  findAccountById.mockResolvedValue(null);
  await expect(readCurrentAccount(authClient().client)).resolves.toEqual({ state: "missing-profile" });
});

it.each(["repository"])("translates %s failures with sanitized logging", async (boundary) => {
  const failure = new QueryFailedError("sensitive SQL", ["private value"],
    Object.assign(new Error("postgresql://secret:password@host/database"), { code: "40001" }));
  (boundary === "data source" ? getDataSource : findAccountById).mockRejectedValue(failure);

  await expect(readCurrentAccount(authClient().client)).resolves.toEqual({ state: "load-error" });
  expect(logError).toHaveBeenCalledExactlyOnceWith({
    event: "auth.account_load_failed", kind: "serialization_failure", sqlState: "40001",
  }, "Failed to load the authenticated application account");
  if (boundary === "data source") expect(findAccountById).not.toHaveBeenCalled();
});

it.each([
  { ...persistence, roleCodes: ["member"] },
])("rejects invalid persistence data (%j)", async (invalid) => {
  findAccountById.mockResolvedValue(invalid);
  await expect(readCurrentAccount(authClient().client)).resolves.toEqual({ state: "load-error" });
});
