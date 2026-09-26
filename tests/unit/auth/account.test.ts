import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readCurrentAccount } from "../../../src/lib/auth/account";

type ProfileResult = {
  data: { email: string; status: string } | null;
  error: { code: string } | null;
};

type RolesResult = {
  data: { role_code: string }[] | null;
  error: { code: string } | null;
};

function accountClient(profile: ProfileResult, roles: RolesResult) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: "member-1" } }, error: null }),
    },
    from(table: string) {
      if (table === "users") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => profile }) }),
        };
      }

      if (table === "user_roles") {
        return {
          select: () => ({ eq: () => ({ order: async () => roles }) }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  } as unknown as Parameters<typeof readCurrentAccount>[0];
}

describe("account loading", () => {
  it("returns the loaded profile and roles", async () => {
    const result = await readCurrentAccount(
      accountClient(
        { data: { email: "member@example.com", status: "active" }, error: null },
        { data: [], error: null },
      ),
    );

    expect(result).toStrictEqual({
      state: "active",
      userId: "member-1",
      email: "member@example.com",
      roles: [],
    });
  });

  it("returns missing-profile only when the profile query succeeds without a row", async () => {
    const result = await readCurrentAccount(
      accountClient(
        { data: null, error: null },
        { data: [], error: null },
      ),
    );

    expect(result).toStrictEqual({ state: "missing-profile" });
  });

  it("returns load-error for a failed profile query", async () => {
    const result = await readCurrentAccount(
      accountClient(
        { data: null, error: { code: "42501" } },
        { data: [], error: null },
      ),
    );

    expect(result).toStrictEqual({ state: "load-error" });
  });

  it("does not classify a failed roles query as a missing profile", async () => {
    const result = await readCurrentAccount(
      accountClient(
        { data: null, error: null },
        { data: null, error: { code: "42501" } },
      ),
    );

    expect(result).toStrictEqual({ state: "load-error" });
  });
});

it("rejects the removed member role at the account boundary", async () => {
  expect(await readCurrentAccount(accountClient(
    { data: { email: "user@example.com", status: "active" }, error: null },
    { data: [{ role_code: "member" }], error: null },
  ))).toEqual({ state: "load-error" });
});
