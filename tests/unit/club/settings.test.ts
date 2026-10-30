import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { EntityManager } from "typeorm";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), fence: vi.fn(), read: vi.fn(), write: vi.fn(), readContact: vi.fn(), writeContact: vi.fn(), user: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));
vi.mock("@/lib/admin/authorization", () => ({ requireActiveAdmin: mocks.admin }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.user } }) }));
vi.mock("@/lib/db/data-source", () => ({ getDataSource: async () => ({ manager: {} }) }));
vi.mock("@/lib/db/transaction", () => ({ inTransaction: (work: (manager: EntityManager) => Promise<unknown>) => work({} as EntityManager) }));
vi.mock("@/lib/db/repositories/accounts.repository", () => ({ lockActiveAdminAccount: mocks.fence }));
vi.mock("@/lib/db/repositories/club-settings.repository", () => ({ readClubSettings: mocks.read, writeClubSettings: mocks.write,
  readClubContact: mocks.readContact, writeClubContact: mocks.writeContact }));
import { readAdminClubContact, readAdminClubSettings, saveClubContact, saveClubSettings, sendClubTestEmail } from "@/lib/club/settings";
import * as brevo from "@/lib/notifications/brevo";
import { clubContactSchema, clubSettingsSchema, telephoneHref } from "@/lib/club/schema";

const settings = { officialEmail: "official@example.com", senderName: "Club Name", emailsEnabled: true };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("BREVO_API_KEY", "mock"); vi.stubEnv("NOTIFICATION_EMAIL_MODE", "sandbox");
  mocks.admin.mockResolvedValue({ userId: "admin-id" }); mocks.fence.mockResolvedValue(true);
  mocks.read.mockResolvedValue(settings);
  mocks.user.mockResolvedValue({ data: { user: { id: "admin-id", email: "verified@example.com", email_confirmed_at: "2026-01-01" } }, error: null });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messageId: "<test>" }), { status: 201 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test("only authorized Admin can read, update or send tests", async () => {
  mocks.admin.mockRejectedValue(new Error("Denied"));
  await expect(readAdminClubSettings()).rejects.toThrow("Denied");
  await expect(saveClubSettings(settings)).rejects.toThrow("Denied");
  await expect(sendClubTestEmail()).rejects.toThrow("Denied");
  expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

test("loads saved values and persists normalized settings after locked authorization", async () => {
  expect(await readAdminClubSettings()).toEqual(settings);
  expect(await saveClubSettings({ ...settings, officialEmail: " official@example.com ", senderName: " Club Name " }))
    .toEqual({ ok: true, settings });
  expect(mocks.write).toHaveBeenCalledWith(expect.anything(), settings);
  mocks.fence.mockResolvedValue(false);
  mocks.write.mockClear();
  expect((await saveClubSettings(settings)).ok).toBe(false); expect(mocks.write).not.toHaveBeenCalled();
});

test.each([{ ...settings, officialEmail: "invalid" }, { ...settings, senderName: " " }, { ...settings, senderName: "a\nb" }])("validates sender input", async input => {
  expect((await saveClubSettings(input)).ok).toBe(false); expect(mocks.write).not.toHaveBeenCalled();
});

test("test email uses saved sender and verified identity and reports acceptance without provider identifiers", async () => {
  expect(await sendClubTestEmail()).toMatchObject({ ok: true, message: "Test request accepted by Brevo in sandbox mode. No email will arrive." });
  expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ messageId: "<test>", mode: "sandbox" }), expect.any(String));
  const request = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
  expect(request.headers["X-Sib-Sandbox"]).toBe("drop");
  expect(request.sender).toEqual({ email: settings.officialEmail, name: settings.senderName });
  expect(request.to).toEqual([{ email: "verified@example.com" }]);
  expect(mocks.write).not.toHaveBeenCalled();
});

test("provider rejection details stay in server logs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "invalid_parameter", message: "Sender is not authorized" }), { status: 400 })));
  expect(await sendClubTestEmail()).toEqual({ ok: false, message: "Brevo rejected the email. Check the sender configuration and recipient address." });
  expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ error: "Brevo HTTP 400: invalid_parameter: Sender is not authorized" }), expect.any(String));
});

test("test action rejects disabled, unsaved or unverified configuration", async () => {
  mocks.read.mockResolvedValueOnce({ ...settings, emailsEnabled: false });
  expect((await sendClubTestEmail()).ok).toBe(false);
  mocks.read.mockResolvedValueOnce({ ...settings, officialEmail: "" });
  expect((await sendClubTestEmail()).ok).toBe(false);
  mocks.user.mockResolvedValue({ data: { user: { id: "admin-id", email: "unverified@example.com" } }, error: null });
  expect((await sendClubTestEmail()).ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
});

test("disabled settings still validate sender fields", () => {
  expect(clubSettingsSchema.safeParse({ ...settings, emailsEnabled: false }).success).toBe(true);
});

test.each([
  [401, "Brevo authentication failed. Check the configured API key."],
  [403, "Brevo denied the request. Check sender authorization and account permissions."],
  [429, "Brevo is receiving too many requests. Try again later."],
  [503, "Brevo is temporarily unavailable. Try again later."],
])("sanitizes HTTP %i provider failures", async (status, message) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Raw SMTP identifier <private-id>" }), { status })));
  expect(await sendClubTestEmail()).toEqual({ ok: false, message });
  expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("<private-id>") }), expect.any(String));
});

test("logs configuration errors without returning their details", async () => {
  vi.stubEnv("BREVO_API_KEY", "");
  expect(await sendClubTestEmail()).toEqual({ ok: false, message: "Unable to send the test email. Check server email configuration." });
  expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Error) }), expect.any(String));
  expect(fetch).not.toHaveBeenCalled();
});

const contact = { contactEmail: "hello@example.com", contactPhone: "+40 21 123 4567" };

test("only authorized Admin can read or update public contact details", async () => {
  mocks.admin.mockRejectedValue(new Error("Denied"));
  await expect(readAdminClubContact()).rejects.toThrow("Denied");
  await expect(saveClubContact(contact)).rejects.toThrow("Denied");
  expect(mocks.readContact).not.toHaveBeenCalled(); expect(mocks.writeContact).not.toHaveBeenCalled();
});

test("saves normalized contact details alone, never the email sender settings", async () => {
  expect(await saveClubContact({ contactEmail: " hello@example.com ", contactPhone: " +40 21 123 4567 " }))
    .toEqual({ ok: true, contact });
  expect(mocks.writeContact).toHaveBeenCalledWith(expect.anything(), contact);
  expect(mocks.write).not.toHaveBeenCalled();
  expect(await saveClubContact({ contactEmail: "", contactPhone: "" })).toEqual({ ok: true, contact: { contactEmail: "", contactPhone: "" } });
  mocks.fence.mockResolvedValue(false); mocks.writeContact.mockClear();
  expect((await saveClubContact(contact)).ok).toBe(false); expect(mocks.writeContact).not.toHaveBeenCalled();
});

test.each([
  { ...contact, contactEmail: "not-an-email" }, { ...contact, contactPhone: "12345" }, { ...contact, contactPhone: "call us" },
  { ...contact, contactPhone: "+1 234 567 890 123 456" }, { ...contact, contactPhone: "++40 21 123 4567" }, { ...contact, extra: true },
])("rejects invalid contact details", async input => {
  expect((await saveClubContact(input)).ok).toBe(false); expect(mocks.writeContact).not.toHaveBeenCalled();
});

test("telephone links keep only dialable characters", () => {
  expect(telephoneHref("+40 (21) 123-4567")).toBe("tel:+40211234567");
  expect(telephoneHref("021 123 4567")).toBe("tel:0211234567");
  expect(clubContactSchema.safeParse({ contactEmail: "", contactPhone: "(021) 123.4567" }).success).toBe(true);
});


test("live test feedback reports provider acceptance without promising delivery", async () => {
  // Stub transport/config: automated tests must never dispatch live mail.
  vi.spyOn(brevo, "brevoConfig").mockReturnValue({ apiKey: "mock", sender: settings.officialEmail, mode: "live" });
  vi.spyOn(brevo, "sendBrevoEmail").mockResolvedValue({ ok: true, messageId: "<test>" });
  expect(await sendClubTestEmail()).toEqual({ ok: true,
    message: "Test email accepted by Brevo. Acceptance does not confirm inbox delivery." });
  expect(fetch).not.toHaveBeenCalled();
});
