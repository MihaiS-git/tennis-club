// @vitest-environment jsdom
import { expectToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminCoach, AdminCoachingLocation, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";

const actions = vi.hoisted(() => ({
  deleteCoachingProgramAction: vi.fn(), deleteCoachProfileAction: vi.fn(),
  saveCoachingProgramAction: vi.fn(), setCoachingProgramStatusAction: vi.fn(), saveCoachProfileAction: vi.fn(),
  setCoachVisibilityAction: vi.fn(), saveClubCoachingPricesAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/coaching/prices" }));
vi.mock("@/app/admin/coaching/actions", () => actions);

import { ProgramDialog } from "@/app/admin/coaching/programs/program-dialog";
import { ProgramsTable } from "@/app/admin/coaching/programs/programs-table";
import { CoachesTable } from "@/app/admin/coaching/coaches/coaches-table";
import { CoachDialog } from "@/app/admin/coaching/coaches/coach-dialog";
import { PricesTable } from "@/app/admin/coaching/prices/prices-table";
import { ClubPriceEditor } from "@/app/admin/coaching/prices/club-price-editor";
import { coachingFailureMessages } from "@/app/admin/coaching/coaching-form";
import { priceFiltersSchema } from "@/lib/coaching/admin-filters";

const location: AdminCoachingLocation = { id: "b1000000-0000-4000-8000-000000000001", name: "East Club", currency: "RON", is_active: true };
const program: AdminCoachingProgram = { id: "a1000000-0000-4000-8000-000000000001", name: "Private lesson", description: "",
  program_type: "private", durations: [60], min_participants: 1, max_participants: 1, court_rental_included: true, is_active: true };
const coach: AdminCoach = { user_id: "c1000000-0000-4000-8000-00000000000a", display_name: "Ana Pop", bio: "", qualifications: "",
  specialties: [], languages: [], is_public: false, email: "ana@example.test", location_ids: [location.id], program_ids: [program.id], ineligibility: null };
const target = { program_id: program.id, duration_minutes: 60, participant_count: 1, currency: "RON" as const };
const ron = { currency: "RON" as const, location_names: [location.name] };
const eur = { currency: "EUR" as const, location_names: ["West Club"] };

beforeEach(() => {
  vi.clearAllMocks();
  installDialogMock();
});
afterEach(cleanup);

it("creates a program with the explicit fields and selected durations", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog />);
  fireEvent.click(screen.getByRole("button", { name: "Create program" }));
  const dialog = screen.getByRole("dialog", { name: "Create program" });
  fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Junior squad" } });
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "junior" } });
  expect(within(dialog).queryByLabelText("Pricing unit")).toBeNull();
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  expect(within(dialog).queryByLabelText(/Other durations/)).toBeNull();
  expect(within(dialog).getAllByRole("checkbox").map((input) => input.getAttribute("value"))).toEqual(["60", "90", "120"]);
  const save = within(dialog).getByRole("button", { name: "Save program" }) as HTMLButtonElement;
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "8" } });
  // An active program cannot be saved without both limits.
  expect(within(dialog).getByText("Enter the minimum players for an active program.")).toBeTruthy();
  expect(within(dialog).getByLabelText("Minimum players").getAttribute("aria-invalid")).toBe("true");
  expect(save.disabled).toBe(true);
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "9" } });
  expect(within(dialog).getByText("Maximum must be at least the minimum.")).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "4" } });
  expect(within(dialog).queryByText(/Enter the minimum players|Maximum must be at least/)).toBeNull();
  fireEvent.click(save);
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledOnce());
  expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ fields: { name: "Junior squad", description: "", program_type: "junior",
    durations: [60, 90], min_participants: 4, max_participants: 8, court_rental_included: false, is_active: true } });
  await expectToast("Program created.", "success");
  expect(router.refresh).toHaveBeenCalled();
});

it("offers one club lesson price/person per duration and number of players for every program type", () => {
  render(<ProgramDialog currencies={[ron]} />);
  fireEvent.click(screen.getByRole("button", { name: "Create program" }));
  const dialog = screen.getByRole("dialog", { name: "Create program" });
  expect(within(dialog).getByText(/Enter the minimum and maximum players to set a price/)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "semi_private" } });
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "2" } });
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "4" } });
  const inputs = () => within(within(dialog).getByRole("region", { name: "Club prices in RON" })).getAllByRole("textbox")
    .map((input) => input.getAttribute("id")!).map((id) => dialog.querySelector(`label[for="${CSS.escape(id)}"]`)!.textContent);
  expect(inputs()).toEqual([2, 3, 4, 2, 3, 4].map((count, index) =>
    `${count} players, club ${index < 3 ? "60" : "90"} min lesson price/person in RON`));
  // Group and Junior have the same meaning, tied to each explicit duration.
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "group" } });
  expect(inputs()).toEqual([2, 3, 4, 2, 3, 4].map((count, index) =>
    `${count} players, club ${index < 3 ? "60" : "90"} min lesson price/person in RON`));
  expect(within(dialog).getByText(/organized by the coach or club and paid at the club/)).toBeTruthy();
});

it("creates a Semi-private program with an independent price for each player count, leaving others unset", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog currencies={[ron, eur]} />);
  fireEvent.click(screen.getByRole("button", { name: "Create program" }));
  const dialog = screen.getByRole("dialog", { name: "Create program" });
  fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Semi-private" } });
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "semi_private" } });
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "2" } });
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "4" } });
  fireEvent.change(within(dialog).getByLabelText("2 players, club 60 min lesson price/person in RON"), { target: { value: "150" } });
  fireEvent.change(within(dialog).getByLabelText("3 players, club 60 min lesson price/person in RON"), { target: { value: "210" } });
  fireEvent.change(within(dialog).getByLabelText("2 players, club 60 min lesson price/person in EUR"), { target: { value: "30" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({
    fields: expect.objectContaining({ program_type: "semi_private", durations: [60], min_participants: 2, max_participants: 4 }),
    club_prices: [
      { currency: "RON", duration_minutes: 60, participant_count: 2, amount: "150" },
      { currency: "RON", duration_minutes: 60, participant_count: 3, amount: "210" },
      { currency: "EUR", duration_minutes: 60, participant_count: 2, amount: "30" },
    ] }));
});

it("states which saved prices a narrower range, removed duration or type change deletes, before saving", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  const semi: AdminCoachingProgram = { ...program, name: "Semi-private", program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 4 };
  const lesson = (id: string, duration_minutes: number, participant_count: number, coach_user_id: string | null = null): AdminCoachingPrice =>
    ({ id, program_id: semi.id, duration_minutes, participant_count, currency: "RON", coach_user_id, amount_minor: 10000 + participant_count });
  const prices = [lesson("p1", 60, 2), lesson("p2", 60, 3), lesson("p3", 60, 4), lesson("p4", 90, 2), lesson("p5", 60, 4, coach.user_id)];
  render(<ProgramDialog program={semi} currencies={[ron]} prices={prices} open />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  expect(within(dialog).queryByRole("status")).toBeNull();
  expect((within(dialog).getByLabelText("4 players, club 60 min lesson price/person in RON") as HTMLInputElement).value).toBe("100.04");
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "3" } });
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 1 club price and 1 coach price");
  expect(within(dialog).queryByLabelText("4 players, club 60 min lesson price/person in RON")).toBeNull();
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 2 club prices and 1 coach price");
  expect(within(dialog).getByRole("status").textContent).toContain("Existing bookings keep their agreed prices");
  // Restoring the range shows the count again, still holding its saved price until the program is saved.
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "4" } });
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 1 club price");
  // Group and Junior have club prices only: the coach price goes, the club lesson prices/person stay.
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "junior" } });
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 1 club price and 1 coach price");
  expect((within(dialog).getByLabelText("2 players, club 60 min lesson price/person in RON") as HTMLInputElement).value).toBe("100.02");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: semi.id,
    fields: expect.objectContaining({ program_type: "junior", durations: [60] }) }));
});

it("shows an existing active program's missing limits at once and saves once both are set", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog program={{ ...program, min_participants: null, max_participants: null }} open onOpenChange={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  expect(within(dialog).getByText("Enter the minimum players for an active program.")).toBeTruthy();
  expect(within(dialog).getByText("Enter the maximum players for an active program.")).toBeTruthy();
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "1" } });
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "1" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: program.id,
    fields: expect.objectContaining({ min_participants: 1, max_participants: 1, is_active: true }) }));
});

it("keeps the draft and shows the server's field error beside the control", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { durations: "Choose a valid duration." } });
  render(<ProgramDialog program={{ ...program, durations: [60, 90] }} open onOpenChange={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Private coaching" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  expect(await within(dialog).findByText("Choose a valid duration.")).toBeTruthy();
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Private coaching");
  expect(screen.getByRole("dialog", { name: "Edit program" })).toBeTruthy();
});

it("edits program status inline, confirming deactivation", async () => {
  actions.setCoachingProgramStatusAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramsTable programs={[program]} />);
  const [status] = screen.getAllByRole("combobox", { name: "Status of Private lesson" });
  fireEvent.click(status);
  fireEvent.keyDown(status, { key: "Enter" });
  expect(screen.queryByRole("dialog", { name: "Edit program" })).toBeNull();
  fireEvent.change(status, { target: { value: "false" } });
  expect(actions.setCoachingProgramStatusAction).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Deactivate Private lesson?" })).getByRole("button", { name: "Deactivate program" }));
  await waitFor(() => expect(actions.setCoachingProgramStatusAction).toHaveBeenCalledWith({ id: program.id, is_active: false }));
  // Inline control does not open the row's edit dialog.
  expect(screen.queryByRole("dialog", { name: "Edit program" })).toBeNull();
});

it("shows an empty state when no programs exist", () => {
  render(<ProgramsTable programs={[]} />);
  expect(screen.getByText(/No coaching programs yet/)).toBeTruthy();
});

it("prevents showing a coach without an eligible coach account", () => {
  render(<CoachesTable coaches={[listItem({ ...coach, ineligibility: "no-coach-role" })]} locations={[location]} programs={[program]} />);
  const [visibility] = screen.getAllByRole("combobox", { name: "Visibility of Ana Pop" });
  expect((within(visibility).getByRole("option", { name: "Public" }) as HTMLOptionElement).disabled).toBe(true);
  expect(screen.getAllByText("No Coach role").length).toBeGreaterThan(0);
});

it("adds a coach for a selected coach account with public profile fields only", async () => {
  actions.saveCoachProfileAction.mockResolvedValue({ ok: false, reason: "not-eligible" });
  render(<CoachDialog accounts={[{ id: coach.user_id, email: coach.email, suggested_name: "Ana Pop" }]} locations={[location]} programs={[program]} />);
  fireEvent.click(screen.getByRole("button", { name: "Add coach" }));
  const dialog = screen.getByRole("dialog", { name: "Add coach" });
  fireEvent.change(within(dialog).getByLabelText("Coach account"), { target: { value: coach.user_id } });
  expect((within(dialog).getByLabelText("Public name") as HTMLInputElement).value).toBe("Ana Pop");
  fireEvent.input(within(dialog).getByLabelText("Specialties"), { target: { value: "Serve, footwork" } });
  fireEvent.click(within(dialog).getByLabelText("East Club"));
  fireEvent.click(within(dialog).getByLabelText("Private lesson"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save coach" }));
  await waitFor(() => expect(actions.saveCoachProfileAction).toHaveBeenCalledWith({ user_id: coach.user_id, create: true, fields: {
    display_name: "Ana Pop", bio: "", qualifications: "", specialties: ["Serve", "footwork"], languages: [],
    location_ids: [location.id], program_ids: [program.id], is_public: false } }));
  expect(await within(dialog).findByText(/Only active accounts with the Coach role/)).toBeTruthy();
});

it("saves club lesson prices of one duration by player count and keeps rejected input", async () => {
  actions.saveClubCoachingPricesAction.mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { "prices.0": "Too large." } })
    .mockResolvedValueOnce({ ok: true, id: program.id });
  const semi = { ...program, name: "Semi-private", program_type: "semi_private" as const, min_participants: 2, max_participants: 3 };
  render(<ClubPriceEditor program={semi} currency="RON" durationMinutes={60} chargeable prices={[{ participant_count: 3, amount_minor: 21000 }]} />);
  expect(screen.getByRole("columnheader", { name: "Lesson price/person" })).toBeTruthy();
  const input = (count: number) => screen.getByLabelText(`${count} players, Semi-private club 60 min lesson price/person in RON`) as HTMLInputElement;
  expect(input(2).value).toBe("");
  expect(input(3).value).toBe("210.00");
  fireEvent.change(input(2), { target: { value: "150" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prices" }));
  expect(await screen.findByText("Too large.")).toBeTruthy();
  expect(input(2).value).toBe("150");
  fireEvent.change(input(2), { target: { value: "160" } });
  fireEvent.click(screen.getByRole("button", { name: "Save prices" }));
  await waitFor(() => expect(actions.saveClubCoachingPricesAction).toHaveBeenLastCalledWith({ program_id: semi.id, currency: "RON",
    duration_minutes: 60, prices: [{ participant_count: 2, amount: "160" }], removed: [] }));
  await expectToast("Prices saved.", "success");
});

it("edits club prices per currency and shows coach overrides read-only for coaches offering the program", () => {
  const { participant_count, ...key } = target;
  const club: AdminCoachingPrice = { id: "p1", ...key, participant_count, coach_user_id: null, amount_minor: 12000 };
  const override: AdminCoachingPrice = { id: "p2", ...key, participant_count, coach_user_id: coach.user_id, amount_minor: 15000 };
  // Location assignments do not matter: Bo offers the program but teaches nowhere; Cy does not offer it.
  const bo = { ...coach, user_id: "c1000000-0000-4000-8000-00000000000b", display_name: "Bo", location_ids: [] };
  const cy = { ...coach, user_id: "c1000000-0000-4000-8000-00000000000c", display_name: "Cy", program_ids: [] };
  const boOverride: AdminCoachingPrice = { ...override, id: "p3", coach_user_id: bo.user_id, amount_minor: 9000 };
  const cyOverride: AdminCoachingPrice = { ...override, id: "p4", coach_user_id: cy.user_id, amount_minor: 1000 };
  render(<PricesTable rows={[{ program, durationMinutes: 60, currency: { currency: "RON", location_names: [location.name] } }]}
    coaches={[coach, bo, cy]} prices={[club, override, boOverride, cyOverride]} filters={priceFiltersSchema.parse({})} filtered={false} sortLinks={{}} />);
  const table = screen.getByRole("table", { name: "Coaching prices" });
  expect((within(table).getByLabelText("1 player, Private lesson club 60 min lesson price/person in RON") as HTMLInputElement).value).toBe("120.00");
  expect(table.textContent).toContain("East Club");
  expect(table.textContent).toContain("Ana Pop, 1 player:");
  expect(table.textContent).toContain("Bo, 1 player:");
  expect(table.textContent).not.toContain("Cy");
  // Admins cannot edit a coach's own price.
  expect(within(table).queryByRole("button", { name: /Coach prices/ })).toBeNull();
  expect(within(table).getAllByRole("textbox")).toHaveLength(1);
});

it("edits an existing coach's public profile, specialties, qualifications, languages and assignments from the table", async () => {
  actions.saveCoachProfileAction.mockResolvedValueOnce({ ok: false, reason: "has-availability" }).mockResolvedValueOnce({ ok: true, id: coach.user_id });
  const west: AdminCoachingLocation = { id: "b1000000-0000-4000-8000-000000000002", name: "West Club", currency: "EUR", is_active: true };
  const group: AdminCoachingProgram = { ...program, id: "a1000000-0000-4000-8000-000000000002", name: "Group drills", is_active: false };
  render(<CoachesTable coaches={[listItem({ ...coach, specialties: ["Serve"], languages: ["English"], qualifications: "Level 1" })]}
    locations={[location, west]} programs={[program, group]} />);
  fireEvent.click(screen.getByRole("row", { name: "Edit coach Ana Pop" }));
  const dialog = screen.getByRole("dialog", { name: "Edit coach" });
  expect(dialog.textContent).toContain("ana@example.test");
  expect(within(dialog).queryByLabelText("Coach account")).toBeNull();
  expect((within(dialog).getByLabelText("Specialties") as HTMLInputElement).value).toBe("Serve");
  fireEvent.input(within(dialog).getByLabelText("Public name"), { target: { value: "Ana Popescu" } });
  fireEvent.input(within(dialog).getByLabelText("Biography"), { target: { value: "Coaching since 2010." } });
  fireEvent.input(within(dialog).getByLabelText("Qualifications"), { target: { value: "Level 3" } });
  fireEvent.input(within(dialog).getByLabelText("Specialties"), { target: { value: "Serve, Volleys" } });
  fireEvent.input(within(dialog).getByLabelText("Languages"), { target: { value: "English, Romanian" } });
  fireEvent.click(within(dialog).getByLabelText("East Club"));
  fireEvent.click(within(dialog).getByLabelText("West Club"));
  fireEvent.click(within(dialog).getByLabelText("Group drills (inactive)"));
  fireEvent.change(within(dialog).getByLabelText("Public visibility"), { target: { value: "true" } });
  const expected = { user_id: coach.user_id, create: false, fields: { display_name: "Ana Popescu", bio: "Coaching since 2010.",
    qualifications: "Level 3", specialties: ["Serve", "Volleys"], languages: ["English", "Romanian"],
    location_ids: [west.id], program_ids: [program.id, group.id], is_public: true } };
  fireEvent.click(within(dialog).getByRole("button", { name: "Save coach" }));
  await waitFor(() => expect(actions.saveCoachProfileAction).toHaveBeenCalledWith(expected));
  // A dependency failure keeps the draft open beside the form.
  expect(await within(dialog).findByText(/availability at a removed location/)).toBeTruthy();
  expect((within(dialog).getByLabelText("Public name") as HTMLInputElement).value).toBe("Ana Popescu");
  fireEvent.click(within(dialog).getByLabelText("East Club"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save coach" }));
  await expectToast("Coach updated.", "success");
  expect(actions.saveCoachProfileAction).toHaveBeenLastCalledWith({ ...expected, fields: { ...expected.fields, location_ids: [location.id, west.id] } });
});

it("shows only the Delete program action and offers explicit deactivation for history", async () => {
  actions.deleteCoachingProgramAction.mockResolvedValue({ ok: false, reason: "has-bookings" });
  actions.setCoachingProgramStatusAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramsTable programs={[program]} />);
  const row = screen.getByRole("row", { name: "Edit program Private lesson" });
  expect(within(row).queryByRole("button", { name: "Edit program" })).toBeNull();
  const button = within(row).getByRole("button", { name: "Delete program" });
  fireEvent.click(button);
  expect(screen.queryByRole("dialog", { name: "Edit program" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "Delete Private lesson?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete program" }));
  expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Deactivate"));
  expect(actions.deleteCoachingProgramAction).toHaveBeenCalledWith({ id: program.id });
  fireEvent.click(within(dialog).getByRole("button", { name: "Deactivate program" }));
  await expectToast("Program deactivated.", "success");
});

it.each([false, true])("confirms coach removal and reports physical deletion versus archiving (archive=%s)", async archived => {
  actions.deleteCoachProfileAction.mockResolvedValue({ ok: true, id: coach.user_id, archived });
  render(<CoachesTable coaches={[listItem(coach)]} locations={[location]} programs={[program]} />);
  const row = screen.getByRole("row", { name: "Edit coach Ana Pop" });
  expect(within(row).queryByRole("button", { name: "Edit coach" })).toBeNull();
  const button = within(row).getByRole("button", { name: "Delete coach" });
  fireEvent.click(button);
  expect(actions.deleteCoachProfileAction).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Edit coach" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "Remove Ana Pop?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove coach" }));
  await waitFor(() => expect(actions.deleteCoachProfileAction).toHaveBeenCalledWith({ user_id: coach.user_id }));
  await expectToast(archived ? "Coach archived and removed from the roster." : "Coach profile deleted.", "success");
});

it("offers only permitted durations when editing a legacy program", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog program={{ ...program, name: "Junior coaching", program_type: "junior", durations: [45, 60] }} open />);
  expect(screen.queryByLabelText("45 min")).toBeNull();
  fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Junior coaching updated" } });
  fireEvent.click(screen.getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: program.id,
    fields: expect.objectContaining({ name: "Junior coaching updated", durations: [60] }) }));
  await expectToast("Program updated.", "success");
});

it("edits every program field in the existing dialog from a row click", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramsTable programs={[program]} />);
  fireEvent.click(screen.getByRole("row", { name: "Edit program Private lesson" }));
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe(program.name);
  fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Partner lesson" } });
  fireEvent.input(within(dialog).getByLabelText("Description"), { target: { value: "Two players together" } });
  fireEvent.change(within(dialog).getByLabelText("Program type"), { target: { value: "semi_private" } });
  fireEvent.click(within(dialog).getByLabelText("60 min"));
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  fireEvent.input(within(dialog).getByLabelText("Minimum players"), { target: { value: "2" } });
  fireEvent.input(within(dialog).getByLabelText("Maximum players"), { target: { value: "2" } });
  fireEvent.change(within(dialog).getByLabelText("Court rental"), { target: { value: "false" } });
  fireEvent.change(within(dialog).getByLabelText("Status"), { target: { value: "false" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: program.id, fields: {
    name: "Partner lesson", description: "Two players together", program_type: "semi_private", durations: [90],
    min_participants: 2, max_participants: 2, court_rental_included: false, is_active: false,
  } }));
});

it("keeps coach removal open with a clear active-lesson explanation", async () => {
  actions.deleteCoachProfileAction.mockResolvedValue({ ok: false, reason: "active-lessons" });
  render(<CoachesTable coaches={[listItem(coach)]} locations={[location]} programs={[program]} />);
  fireEvent.click(within(screen.getByRole("row", { name: "Edit coach Ana Pop" })).getByRole("button", { name: "Delete coach" }));
  expect(screen.queryByRole("dialog", { name: "Edit coach" })).toBeNull();
  const dialog = screen.getByRole("dialog", { name: "Remove Ana Pop?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove coach" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("Handle those lessons first");
  expect(screen.getByRole("dialog", { name: "Remove Ana Pop?" })).toBeTruthy();
});

function listItem(profile: AdminCoach): import("@/lib/coaching/admin-lists").AdminCoachListItem {
  return { user_id: profile.user_id, name: profile.display_name, email: profile.email,
    account_status: profile.ineligibility === "suspended" ? "suspended" : "active", profile_status: "configured", profile };
}

it("configures a missing profile directly from its account row", async () => {
  actions.saveCoachProfileAction.mockResolvedValue({ ok: true, id: coach.user_id });
  render(<CoachesTable coaches={[{ ...listItem(coach), profile: null, profile_status: "not-configured" }]}
    locations={[location]} programs={[program]} />);
  const row = screen.getByRole("row", { name: "Configure profile Ana Pop" });
  expect(row.textContent).toContain("Not configured");
  fireEvent.click(within(row).getByRole("button", { name: "Configure profile" }));
  const dialog = screen.getByRole("dialog", { name: "Add coach" });
  expect(within(dialog).queryByLabelText("Coach account")).toBeNull();
  expect((within(dialog).getByLabelText("Public name") as HTMLInputElement).value).toBe("Ana Pop");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save coach" }));
  await waitFor(() => expect(actions.saveCoachProfileAction).toHaveBeenCalledWith({ user_id: coach.user_id, create: true,
    fields: expect.objectContaining({ display_name: "Ana Pop", is_public: false, location_ids: [], program_ids: [] }) }));
});

it("shows archived profiles without offering mutations or a new profile", () => {
  render(<CoachesTable coaches={[{ ...listItem(coach), profile_status: "archived", account_status: "suspended" }]}
    locations={[location]} programs={[program]} />);
  const row = screen.getByRole("row", { name: "Archived coach Ana Pop" });
  expect(row.textContent).toContain("Suspended");
  expect(row.textContent).toContain("Archived");
  expect(within(row).queryByRole("button")).toBeNull();
  expect(within(row).queryByRole("combobox")).toBeNull();
});

it.each(["Enter", " "])("opens program editing from the keyboard with %s", (key) => {
  render(<ProgramsTable programs={[program]} />);
  const row = screen.getByRole("row", { name: "Edit program Private lesson" });
  expect(row.tabIndex).toBe(0);
  fireEvent.keyDown(row, { key });
  expect(screen.getByRole("dialog", { name: "Edit program" })).toBeTruthy();
});

it.each(["Enter", " "])("opens coach editing from the keyboard with %s", (key) => {
  render(<CoachesTable coaches={[listItem(coach)]} locations={[location]} programs={[program]} />);
  const row = screen.getByRole("row", { name: "Edit coach Ana Pop" });
  expect(row.tabIndex).toBe(0);
  fireEvent.keyDown(row, { key });
  expect(screen.getByRole("dialog", { name: "Edit coach" })).toBeTruthy();
});

const groupProgram: AdminCoachingProgram = { ...program, id: "a1000000-0000-4000-8000-000000000003", name: "Group drills",
  program_type: "group", durations: [60, 90], min_participants: 3, max_participants: 5, court_rental_included: false };
const rate = (participant_count: number, amount_minor: number): AdminCoachingPrice =>
  ({ id: `r${participant_count}`, program_id: groupProgram.id, duration_minutes: 90, participant_count, coach_user_id: null, amount_minor, currency: "RON" });

it("lists a Group program per duration and currency with club-only lesson prices/person by player count", () => {
  render(<PricesTable rows={[{ program: groupProgram, durationMinutes: 90, currency: { currency: "RON", location_names: [location.name] } }]}
    coaches={[coach]} prices={[rate(3, 6000)]} filters={priceFiltersSchema.parse({})} filtered={false} sortLinks={{}} />);
  const table = screen.getByRole("table", { name: "Coaching prices" });
  expect(table.textContent).toContain("Lesson price/person");
  expect(table.textContent).toContain("Club prices only");
  expect(table.textContent).not.toContain("Ana Pop");
  const form = within(table).getByRole("form", { name: "Group drills club prices in RON" });
  expect(within(form).getAllByRole("textbox").map((input) => (input as HTMLInputElement).value)).toEqual(["60.00", "", ""]);
});

it("creates, edits and removes Group lesson prices/person by player count and saves only the changes", async () => {
  actions.saveClubCoachingPricesAction.mockResolvedValue({ ok: true, id: groupProgram.id });
  render(<ClubPriceEditor program={groupProgram} currency="RON" durationMinutes={90} chargeable prices={[rate(3, 6000), rate(4, 5000)]} />);
  expect(screen.getByRole("columnheader", { name: "Lesson price/person" })).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save prices" }) as HTMLButtonElement;
  const input = (count: number) => screen.getByLabelText(`${count} players, Group drills club 90 min lesson price/person in RON`) as HTMLInputElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "60" } });
  // The same amount is not a change.
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "55.50" } });
  fireEvent.change(input(5), { target: { value: "45" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove Group drills RON club 90 min lesson price/person, 4 players" }));
  expect(input(4).disabled).toBe(true);
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(actions.saveClubCoachingPricesAction).toHaveBeenCalledWith({ program_id: groupProgram.id, currency: "RON",
    duration_minutes: 90, prices: [{ participant_count: 3, amount: "55.50" }, { participant_count: 5, amount: "45" }], removed: [4] }));
  await expectToast("Prices saved.", "success");
  expect(router.refresh).toHaveBeenCalled();
});

it("blocks invalid Group lesson prices/person and keeps entered values with the server's errors", async () => {
  actions.saveClubCoachingPricesAction
    .mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { "prices.0": "Use a player count from 3 to 4." } })
    .mockResolvedValueOnce({ ok: false, reason: "invalid-currency" });
  render(<ClubPriceEditor program={groupProgram} currency="RON" durationMinutes={90} chargeable prices={[rate(3, 6000)]} />);
  const save = screen.getByRole("button", { name: "Save prices" }) as HTMLButtonElement;
  const input = (count: number) => screen.getByLabelText(`${count} players, Group drills club 90 min lesson price/person in RON`) as HTMLInputElement;
  for (const value of ["0", "-5", "12.345", "abc"]) {
    fireEvent.change(input(4), { target: { value } });
    expect(input(4).getAttribute("aria-invalid")).toBe("true");
    expect(save.disabled).toBe(true);
  }
  // Clearing a saved price is not a removal; Remove is explicit.
  fireEvent.change(input(4), { target: { value: "" } });
  fireEvent.change(input(3), { target: { value: "" } });
  expect(screen.getByText("Enter a price, or use Remove to clear it.")).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "60" } });
  fireEvent.change(input(5), { target: { value: "40" } });
  fireEvent.click(save);
  expect(await screen.findByText("Use a player count from 3 to 4.")).toBeTruthy();
  expect(input(5).value).toBe("40");
  // The rejected entry must change before it can be saved again.
  expect(save.disabled).toBe(true);
  fireEvent.change(input(5), { target: { value: "35" } });
  fireEvent.click(save);
  expect((await screen.findByRole("alert")).textContent).toBe(coachingFailureMessages["invalid-currency"]);
  expect(input(5).value).toBe("35");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("keeps prices in a currency no current location charges in removable but unpublished, and explains a missing range", async () => {
  actions.saveClubCoachingPricesAction.mockResolvedValue({ ok: true, id: groupProgram.id });
  render(<ClubPriceEditor program={groupProgram} currency="RON" durationMinutes={90} chargeable={false} prices={[rate(4, 3000)]} />);
  expect(screen.getByText("No current location charges in RON.")).toBeTruthy();
  expect(screen.getByText(/4 players: 30.00 RON/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove Group drills RON club 90 min lesson price/person, 4 players" }));
  fireEvent.click(screen.getByRole("button", { name: "Save prices" }));
  await waitFor(() => expect(actions.saveClubCoachingPricesAction).toHaveBeenCalledWith({ program_id: groupProgram.id, currency: "RON",
    duration_minutes: 90, prices: [], removed: [4] }));
  cleanup();
  render(<ClubPriceEditor program={{ ...groupProgram, max_participants: null }} currency="RON" durationMinutes={90} chargeable prices={[]} />);
  expect(screen.getByText(/Set the program’s minimum and maximum players under Programs/)).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save prices" })).toBeNull();
});
