import { beforeEach, describe, expect, it, vi } from "vitest";

const { resend, signInWithPassword, signOut } = vi.hoisted(() => ({
  resend: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn(),
}));
vi.mock("../../../src/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { resend, signInWithPassword, signOut } }),
}));

import { resendConfirmationAction, signInAction } from "../../../src/app/(auth)/actions";
import { CONFIRMATION_RESEND_SUCCESS } from "../../../src/lib/auth/confirmation";
import { getApplicationUrl } from "../../../src/lib/auth/site-url";

function form(email = "member@example.com") {
  const data = new FormData();
  data.set("email", email);
  return data;
}

describe("resend signup confirmation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("validates email before requesting an email", async () => {
    expect(await resendConfirmationAction({}, form("invalid"))).toEqual({
      fieldErrors: { email: "Enter a valid email address." },
    });
    expect(resend).not.toHaveBeenCalled();
  });

  it("uses the existing signup callback and ignores submitted redirect/type", async () => {
    resend.mockResolvedValue({ error: null });
    const data = form("  member@example.com  ");
    data.set("type", "recovery");
    data.set("emailRedirectTo", "https://attacker.example");
    expect(await resendConfirmationAction({}, data)).toEqual({ success: CONFIRMATION_RESEND_SUCCESS });
    expect(resend).toHaveBeenCalledExactlyOnceWith({
      type: "signup", email: "member@example.com",
      options: { emailRedirectTo: getApplicationUrl("/auth/callback?next=/account&flow=email-confirmation") },
    });
  });

  it.each(["user_not_found", "user_already_exists", "email_exists", "email_not_confirmed"])("conceals account-specific %s errors", async (code) => {
    resend.mockResolvedValue({ error: { code, message: "Private provider details" } });
    expect(await resendConfirmationAction({}, form())).toEqual({ success: CONFIRMATION_RESEND_SUCCESS });
  });

  it.each([{ status: 429 }, { code: "over_email_send_rate_limit" }, { code: "over_request_rate_limit" }])("handles rate limits %j", async (error) => {
    resend.mockResolvedValue({ error });
    expect(await resendConfirmationAction({}, form())).toEqual({
      formError: "Too many email requests. Please wait a few minutes before trying again.",
    });
  });

  it("sanitizes unexpected provider and network errors", async () => {
    resend.mockResolvedValueOnce({ error: { code: "unexpected_failure", message: "Private details" } });
    resend.mockRejectedValueOnce(new Error("Private network details"));
    const expected = { formError: "We could not request a confirmation email. Please try again later." };
    expect(await resendConfirmationAction({}, form())).toEqual(expected);
    expect(await resendConfirmationAction({}, form())).toEqual(expected);
  });

  it.each(["email_not_confirmed", "invalid_credentials"])("offers resend only for unconfirmed login (%s)", async (code) => {
    signInWithPassword.mockResolvedValue({ error: { code } });
    const data = form();
    data.set("password", "a password");
    const state = await signInAction({}, data);
    expect(state.emailUnconfirmed).toBe(code === "email_not_confirmed" ? true : undefined);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(resend).not.toHaveBeenCalled();
  });
});
