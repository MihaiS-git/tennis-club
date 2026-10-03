import { beforeEach, expect, it, vi } from "vitest";

const { account, profile } = vi.hoisted(() => ({ account: vi.fn(), profile: vi.fn() }));
vi.mock("@/lib/auth/account", () => ({ readCurrentAccount: account }));
vi.mock("@/lib/profile/profile", () => ({ loadProfile: profile }));

import { bookingContactPrefill } from "@/lib/bookings/prefill";

beforeEach(() => { account.mockReset(); profile.mockReset(); });

it("keeps guest and suspended fields empty", async () => {
  account.mockResolvedValueOnce({ state: "unauthenticated" }).mockResolvedValueOnce({ state: "suspended" });
  const client = {} as Parameters<typeof bookingContactPrefill>[0];
  expect(await bookingContactPrefill(client)).toEqual({ customerName: "", customerEmail: "", customerPhone: "" });
  expect(await bookingContactPrefill(client)).toEqual({ customerName: "", customerEmail: "", customerPhone: "" });
  expect(profile).not.toHaveBeenCalled();
});

it("prefills available account and profile contact without writing to either", async () => {
  account.mockResolvedValue({ state: "active", userId: "user", email: "account@example.test" });
  profile.mockResolvedValue({ personal: { first_name: "Ada", last_name: "Lovelace", phone: "+40 123" }, player: { display_name: "Ada" } });
  const client = {} as Parameters<typeof bookingContactPrefill>[0];
  expect(await bookingContactPrefill(client)).toEqual({ customerName: "Ada Lovelace",
    customerEmail: "account@example.test", customerPhone: "+40 123" });
  expect(profile).toHaveBeenCalledWith(client, "user");
});
