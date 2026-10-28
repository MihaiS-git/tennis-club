// @vitest-environment jsdom
import { expectToast } from "../helpers/notifications";
import { installDialogMock } from "../helpers/dialog";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminCoach, AdminCoachingCurrency, AdminCoachingLocation, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";

const actions = vi.hoisted(() => ({
  deleteCoachingProgramAction: vi.fn(), deleteCoachProfileAction: vi.fn(),
  saveCoachingProgramAction: vi.fn(), setCoachingProgramStatusAction: vi.fn(), saveCoachProfileAction: vi.fn(),
  setCoachVisibilityAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/coaching/programs" }));
vi.mock("@/app/admin/coaching/actions", () => actions);

import { ProgramDialog } from "@/app/admin/coaching/programs/program-dialog";
import { ProgramsTable } from "@/app/admin/coaching/programs/programs-table";
import { CoachesTable } from "@/app/admin/coaching/coaches/coaches-table";
import { CoachDialog } from "@/app/admin/coaching/coaches/coach-dialog";
import { coachingFailureMessages } from "@/app/admin/coaching/coaching-form";

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

const editGroup = (prices: AdminCoachingPrice[], currencies: AdminCoachingCurrency[] = [ron]) => {
  render(<ProgramDialog program={groupProgram} currencies={currencies} prices={prices} open />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  const input = (count: number, currency = "RON", minutes = 90) =>
    within(dialog).getByLabelText(`${count} players, club ${minutes} min lesson price/person in ${currency}`) as HTMLInputElement;
  return { dialog, input, save: within(dialog).getByRole("button", { name: "Save program" }) as HTMLButtonElement };
};

it("creates, edits and removes club lesson prices/person in the Program dialog and saves only the changes", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: groupProgram.id });
  const { dialog, input, save } = editGroup([rate(3, 6000), rate(4, 5000)]);
  expect(input(3).value).toBe("60.00");
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "60" } });
  // The same amount is not a change.
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "55.50" } });
  fireEvent.change(input(5), { target: { value: "45" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove RON 90 min lesson price/person, 4 players" }));
  expect(input(4).disabled).toBe(true);
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: groupProgram.id, fields: expect.objectContaining({ program_type: "group" }),
    club_prices: [{ currency: "RON", duration_minutes: 90, participant_count: 3, amount: "55.50" }, { currency: "RON", duration_minutes: 90, participant_count: 5, amount: "45" }],
    removed_club_prices: [{ currency: "RON", duration_minutes: 90, participant_count: 4 }] }));
  await expectToast("Program updated.", "success");
  expect(router.refresh).toHaveBeenCalled();
});

it("blocks invalid club lesson prices/person and keeps entered values with the server's price and currency errors", async () => {
  actions.saveCoachingProgramAction
    .mockResolvedValueOnce({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": "Use a player count from 3 to 4." } })
    .mockResolvedValueOnce({ ok: false, reason: "invalid-currency" });
  const { dialog, input, save } = editGroup([rate(3, 6000)]);
  for (const value of ["0", "-5", "12.345", "abc"]) {
    fireEvent.change(input(4), { target: { value } });
    expect(input(4).getAttribute("aria-invalid")).toBe("true");
    expect(save.disabled).toBe(true);
  }
  // Clearing a saved price is not a removal; Remove is explicit.
  fireEvent.change(input(4), { target: { value: "" } });
  fireEvent.change(input(3), { target: { value: "" } });
  expect(within(dialog).getByText("Enter a price, or use Remove to clear it.")).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.change(input(3), { target: { value: "60" } });
  fireEvent.change(input(5), { target: { value: "40" } });
  fireEvent.click(save);
  expect(await within(dialog).findByText("Use a player count from 3 to 4.")).toBeTruthy();
  expect(input(5).value).toBe("40");
  fireEvent.change(input(5), { target: { value: "35" } });
  fireEvent.click(save);
  await expectToast(coachingFailureMessages["invalid-currency"], "error");
  expect(input(5).value).toBe("35");
  expect(router.refresh).not.toHaveBeenCalled();
});

it("keeps saved prices in a currency no current location charges visible for removal only", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: groupProgram.id });
  const legacy = { currency: "EUR" as const, location_names: [] };
  const { dialog, input, save } = editGroup([rate(3, 6000), { ...rate(4, 3000), id: "e4", currency: "EUR" }], [ron, legacy]);
  const region = within(dialog).getByRole("region", { name: "Club prices in EUR" });
  expect(region.textContent).toContain("No current location charges EUR. Saved prices can only be removed.");
  // Only the saved EUR price is listed, read-only; no new EUR price can be entered.
  expect(within(region).getAllByRole("textbox")).toHaveLength(1);
  expect(input(4, "EUR").value).toBe("30.00");
  expect(input(4, "EUR").readOnly).toBe(true);
  expect(within(dialog).queryByLabelText("3 players, club 90 min lesson price/person in EUR")).toBeNull();
  expect(input(3).readOnly).toBe(false);
  fireEvent.click(within(region).getByRole("button", { name: "Remove EUR 90 min lesson price/person, 4 players" }));
  fireEvent.click(save);
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: groupProgram.id, fields: expect.anything(),
    removed_club_prices: [{ currency: "EUR", duration_minutes: 90, participant_count: 4 }] }));
  cleanup();
  // Without saved prices, such a currency is not offered at all.
  render(<ProgramDialog program={groupProgram} currencies={[ron, legacy]} prices={[rate(3, 6000)]} open />);
  expect(screen.queryByRole("region", { name: "Club prices in EUR" })).toBeNull();
});

it("shows a coach's individual prices read-only, grouped by program, duration, players and currency", () => {
  const semi: AdminCoachingProgram = { ...program, id: "a1000000-0000-4000-8000-000000000004", name: "Semi-private", program_type: "semi_private", durations: [60, 90], min_participants: 2, max_participants: 3 };
  const own = (id: string, program_id: string, duration_minutes: number, participant_count: number, currency: "RON" | "EUR", amount_minor: number): AdminCoachingPrice =>
    ({ id, program_id, duration_minutes, participant_count, currency, coach_user_id: coach.user_id, amount_minor });
  const prices = [own("o1", semi.id, 90, 2, "RON", 20000), own("o2", semi.id, 60, 3, "RON", 18000), own("o3", semi.id, 60, 2, "EUR", 3000),
    own("o4", semi.id, 60, 2, "RON", 15000), own("o5", program.id, 60, 1, "RON", 12000),
    // Club prices and other coaches' overrides are not this coach's.
    { ...own("c1", program.id, 60, 1, "RON", 9000), coach_user_id: null }, { ...own("x1", program.id, 60, 1, "RON", 9900), coach_user_id: "c1000000-0000-4000-8000-00000000000b" }];
  render(<CoachDialog coach={{ ...coach, program_ids: [program.id, semi.id] }} locations={[location]} programs={[program, semi]} prices={prices} open />);
  const dialog = screen.getByRole("dialog", { name: "Edit coach" });
  const section = within(dialog).getByRole("region", { name: "Individual prices" });
  expect(section.textContent).toContain("Coaches manage them under My prices");
  const rows = (name: string) => within(within(section).getByRole("table", { name: `Individual prices for ${name}` })).getAllByRole("row").slice(1)
    .map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
  expect(within(section).getAllByRole("table").map((table) => table.getAttribute("aria-label"))).toEqual(["Individual prices for Private lesson", "Individual prices for Semi-private"]);
  expect(rows("Private lesson")).toEqual([["60 min", "1 player", "RON", expect.stringContaining("120.00")]]);
  expect(rows("Semi-private").map((row) => row.slice(0, 3))).toEqual([
    ["60 min", "2 players", "EUR"], ["60 min", "2 players", "RON"], ["60 min", "3 players", "RON"], ["90 min", "2 players", "RON"]]);
  // Nothing in the section can edit a price.
  expect(within(section).queryAllByRole("textbox")).toHaveLength(0);
  expect(within(section).queryAllByRole("button")).toHaveLength(0);
});

it("shows an empty state when a coach has no individual prices, and none for a new coach", () => {
  render(<CoachDialog coach={coach} locations={[location]} programs={[program]} prices={[]} open />);
  expect(within(screen.getByRole("region", { name: "Individual prices" })).getByText(/No individual prices/)).toBeTruthy();
  cleanup();
  render(<CoachDialog accounts={[]} locations={[location]} programs={[program]} open />);
  expect(screen.queryByRole("region", { name: "Individual prices" })).toBeNull();
});

it("warns before saving when removing a program assignment deletes the coach's individual prices", async () => {
  actions.saveCoachProfileAction.mockResolvedValue({ ok: true, id: coach.user_id });
  const override: AdminCoachingPrice = { id: "o1", ...target, coach_user_id: coach.user_id, amount_minor: 15000 };
  render(<CoachesTable coaches={[listItem(coach)]} locations={[location]} programs={[program]}
    prices={[override, { ...override, id: "o2", duration_minutes: 90 }]} />);
  fireEvent.click(screen.getByRole("row", { name: "Edit coach Ana Pop" }));
  const dialog = screen.getByRole("dialog", { name: "Edit coach" });
  expect(within(dialog).queryByRole("status")).toBeNull();
  fireEvent.click(within(dialog).getByLabelText("Private lesson"));
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 2 individual prices this coach set for Private lesson");
  expect(within(dialog).getByRole("table", { name: "Individual prices for Private lesson" }).textContent).toContain("Removed when you save");
  // Restoring the assignment withdraws the warning.
  fireEvent.click(within(dialog).getByLabelText("Private lesson"));
  expect(within(dialog).queryByRole("status")).toBeNull();
  fireEvent.click(within(dialog).getByLabelText("Private lesson"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Save coach" }));
  await waitFor(() => expect(actions.saveCoachProfileAction).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ program_ids: [] }) })));
});
