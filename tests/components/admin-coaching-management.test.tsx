// @vitest-environment jsdom
import { installDialogMock } from "../helpers/dialog";
import { expectToast } from "../helpers/notifications";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminCoach, AdminCoachingLocation, AdminCoachingPrice, AdminCoachingProgram } from "@/lib/coaching/admin";
import type { AdminCoachListItem } from "@/lib/coaching/admin-lists";
import { coachFiltersSchema, priceFiltersSchema, programFiltersSchema } from "@/lib/coaching/admin-filters";

const actions = vi.hoisted(() => ({
  deleteCoachingProgramAction: vi.fn(), deleteCoachProfileAction: vi.fn(),
  saveCoachingProgramAction: vi.fn(), setCoachingProgramStatusAction: vi.fn(), saveCoachProfileAction: vi.fn(),
  setCoachVisibilityAction: vi.fn(), saveCoachingPriceAction: vi.fn(), removeCoachingPriceAction: vi.fn(),
}));
const lists = vi.hoisted(() => ({ loadCoachesPage: vi.fn(), loadProgramsPage: vi.fn(), loadPricesPage: vi.fn() }));
const navigation = vi.hoisted(() => ({ query: "", pathname: "/admin/coaching/prices", replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace, refresh: navigation.refresh, push: vi.fn() }),
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.query),
}));
vi.mock("@/app/admin/coaching/actions", () => actions);
vi.mock("@/lib/coaching/admin-lists", () => lists);

import AdminCoachesPage from "@/app/admin/coaching/coaches/page";
import AdminCoachingProgramsPage from "@/app/admin/coaching/programs/page";
import AdminCoachingPricesPage from "@/app/admin/coaching/prices/page";
import { CoachesTable } from "@/app/admin/coaching/coaches/coaches-table";
import { ProgramDialog } from "@/app/admin/coaching/programs/program-dialog";

const central: AdminCoachingLocation = { id: "b1000000-0000-4000-8000-000000000001", name: "Central Club", currency: "RON", is_active: true };
const riverside: AdminCoachingLocation = { id: "b1000000-0000-4000-8000-000000000002", name: "Riverside Club", currency: "EUR", is_active: true };
const program: AdminCoachingProgram = { id: "a1000000-0000-4000-8000-000000000001", name: "Private lesson", description: "",
  program_type: "private", durations: [60, 90], min_participants: 1, max_participants: 1, court_rental_included: true, is_active: true };
const coach: AdminCoach = { user_id: "c1000000-0000-4000-8000-00000000000a", display_name: "Ana Pop", bio: "", qualifications: "",
  specialties: [], languages: [], is_public: true, email: "ana.pop.with.a.long.address@example.test", location_ids: [central.id],
  program_ids: [program.id], ineligibility: null };
const price = (overrides: Partial<AdminCoachingPrice>): AdminCoachingPrice => ({ id: crypto.randomUUID(), program_id: program.id, duration_minutes: 60,
  location_id: central.id, coach_user_id: null, amount_minor: 18000, currency: "RON", current: true, ...overrides });
const item = (overrides: Partial<AdminCoachListItem> = {}): AdminCoachListItem => ({ user_id: coach.user_id, name: coach.display_name, email: coach.email,
  account_status: "active", profile_status: "configured", profile: coach, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  installDialogMock();
  navigation.query = "";
  navigation.pathname = "/admin/coaching/prices";
});
afterEach(cleanup);

function desktopRow(name: string) {
  return screen.getAllByRole("row", { name }).find((row) => row.tagName === "TR")!;
}

it("lays out coaches in seven compact columns with the email below the name", () => {
  render(<CoachesTable coaches={[item()]} locations={[central]} programs={[program]} />);
  const table = screen.getByRole("table", { name: "Coaches" });
  expect(within(table).getAllByRole("columnheader").map((heading) => heading.textContent))
    .toEqual(["Coach", "Account", "Profile", "Visibility", "Locations", "Programs", "Actions"]);
  // No fixed minimum width or horizontal scroll container on desktop.
  expect(table.className).toContain("table-fixed");
  expect(table.className).not.toMatch(/min-w-/);
  expect(table.parentElement?.className).not.toContain("overflow-x-auto");
  const cells = within(desktopRow("Edit coach Ana Pop")).getAllByRole("cell");
  expect(cells).toHaveLength(7);
  expect([...cells[0].querySelectorAll("p")].map((line) => line.textContent)).toEqual(["Ana Pop", coach.email]);
  expect(cells[0].querySelector("p:last-child")?.getAttribute("title")).toBe(coach.email);
  expect(cells.map((cell) => cell.textContent).slice(1, 3)).toEqual(["Active", "Configured"]);
  expect(cells[4].textContent).toBe("Central Club");
  expect(cells[5].textContent).toBe("Private lesson");
  expect(within(cells[6]).getByRole("button", { name: "Edit coach" })).toBeTruthy();
  expect(within(cells[6]).getByRole("button", { name: "Delete coach" })).toBeTruthy();
});

it("shows the email once for an account without a name and Hidden for unconfigured or archived profiles", () => {
  render(<CoachesTable locations={[central]} programs={[program]} coaches={[
    item({ user_id: "c1000000-0000-4000-8000-00000000000b", name: "nameless@example.test", email: "nameless@example.test", profile: null, profile_status: "not-configured" }),
    item({ user_id: "c1000000-0000-4000-8000-00000000000c", name: "Old Coach", email: "old@example.test", profile_status: "archived", profile: { ...coach, is_public: true } }),
  ]} />);
  const nameless = within(desktopRow("Configure profile nameless@example.test")).getAllByRole("cell");
  expect(nameless[0].textContent).toBe("nameless@example.test");
  expect(nameless[0].querySelectorAll("p")).toHaveLength(1);
  expect(nameless[2].textContent).toBe("Not configured");
  expect(nameless[3].textContent).toBe("Hidden");
  // Visibility cannot be edited before a valid profile exists; Configure profile remains.
  expect(within(nameless[3]).queryByRole("combobox")).toBeNull();
  expect(within(nameless[6]).getByRole("button", { name: "Configure profile" }).textContent).toBe("Configure profile");
  const archived = within(desktopRow("Archived coach Old Coach")).getAllByRole("cell");
  expect(archived[3].textContent).toBe("Hidden");
});

it("labels a configured private profile Hidden in its inline visibility control", async () => {
  actions.setCoachVisibilityAction.mockResolvedValue({ ok: true, id: coach.user_id });
  render(<CoachesTable coaches={[item({ profile: { ...coach, is_public: false } })]} locations={[central]} programs={[program]} />);
  const [visibility] = screen.getAllByRole("combobox", { name: "Visibility of Ana Pop" }) as HTMLSelectElement[];
  expect(visibility.selectedOptions[0].text).toBe("Hidden");
  fireEvent.change(visibility, { target: { value: "true" } });
  await waitFor(() => expect(actions.setCoachVisibilityAction).toHaveBeenCalledWith({ user_id: coach.user_id, is_public: true }));
});

function coachesPageData(filters: Record<string, string>) {
  return { coaches: [item()], locations: [central], programs: [program], filters: coachFiltersSchema.parse(filters), total: 21, page: 1, totalPages: 2 };
}

it("sorts coaches only through URL-backed column headings that keep filters", async () => {
  navigation.pathname = "/admin/coaching/coaches";
  navigation.query = "q=ana&status=active&sort=name&dir=asc";
  lists.loadCoachesPage.mockResolvedValue(coachesPageData({ search: "ana", status: "active", sort: "name", dir: "asc", page: "2" }));
  render(await AdminCoachesPage({ searchParams: Promise.resolve({ q: "ana", status: "active", sort: "name", dir: "asc", page: "2" }) }));
  expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
  const table = screen.getByRole("table", { name: "Coaches" });
  const link = (name: string) => new URL(within(table).getByRole("link", { name }).getAttribute("href")!, "http://localhost").searchParams;
  // The active column toggles to descending; others start ascending. Both reset to page 1.
  expect(Object.fromEntries(link("Coach"))).toEqual({ q: "ana", status: "active", sort: "name", dir: "desc", page: "1" });
  expect(Object.fromEntries(link("Email"))).toMatchObject({ q: "ana", status: "active", sort: "email", dir: "asc", page: "1" });
  expect(link("Account").get("sort")).toBe("status");
  expect(link("Profile").get("sort")).toBe("profile");
  expect(within(table).getAllByRole("columnheader")[0].getAttribute("aria-sort")).toBe("ascending");
  expect(screen.getByRole("combobox", { name: "Visibility" }).textContent).toBe("All visibilityPublicHidden");
  // Pagination keeps search, filters and sort.
  expect(Object.fromEntries(new URL(screen.getByRole("link", { name: /2/ }).getAttribute("href")!, "http://localhost").searchParams))
    .toEqual({ q: "ana", status: "active", sort: "name", dir: "asc", page: "2" });
});

it("removes the Programs sort dropdowns and marks the descending heading", async () => {
  navigation.pathname = "/admin/coaching/programs";
  lists.loadProgramsPage.mockResolvedValue({ programs: [program], locations: [central], prices: [], total: 1, page: 1, totalPages: 1,
    filters: programFiltersSchema.parse({ type: "private", sort: "type", dir: "desc" }) });
  render(await AdminCoachingProgramsPage({ searchParams: Promise.resolve({ type: "private", sort: "type", dir: "desc" }) }));
  expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
  const table = screen.getByRole("table", { name: "Coaching programs" });
  const type = within(table).getByRole("link", { name: "Type" });
  expect(type.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  expect(Object.fromEntries(new URL(type.getAttribute("href")!, "http://localhost").searchParams)).toEqual({ type: "private", sort: "type", dir: "asc", page: "1" });
  expect(new URL(within(table).getByRole("link", { name: "Name" }).getAttribute("href")!, "http://localhost").searchParams.get("dir")).toBe("asc");
});

function pricesPageData(filters: Record<string, string>, programs: AdminCoachingProgram[]) {
  return { programs, coaches: [coach], locations: [central], prices: [], total: 18, page: 1, totalPages: 1,
    filters: priceFiltersSchema.parse(filters), groups: [{ program_id: programs[0].id, location_id: central.id, duration_minutes: 60 }] };
}

it("offers a searchable program filter and numerically ordered durations without sort dropdowns", async () => {
  navigation.query = "scope=club&sort=amount&dir=desc&page=2";
  const many = Array.from({ length: 60 }, (_, index) => ({ ...program, id: `a1000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Program ${String(index).padStart(2, "0")}`, durations: [120, 45, 90 + (index % 3) * 5] }));
  lists.loadPricesPage.mockResolvedValue(pricesPageData({ scope: "club", sort: "amount", dir: "desc" }, many));
  render(await AdminCoachingPricesPage({ searchParams: Promise.resolve({ scope: "club", sort: "amount", dir: "desc" }) }));
  expect(screen.getByText(/^18 pricing groups/)).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Sort by" })).toBeNull();
  expect(screen.queryByRole("combobox", { name: "Direction" })).toBeNull();
  expect([...(screen.getByRole("combobox", { name: "Duration" }) as HTMLSelectElement).options].map((option) => option.text))
    .toEqual(["All durations", "45 min", "90 min", "95 min", "100 min", "120 min"]);

  const programFilter = screen.getByRole("combobox", { name: "Program" }) as HTMLInputElement;
  expect(programFilter.value).toBe("All programs");
  fireEvent.focus(programFilter);
  const list = screen.getByRole("listbox", { name: "Program" });
  // The list is height-bounded and scrolls internally.
  expect(list.className).toContain("overflow-y-auto");
  expect(list.style.maxHeight).not.toBe("");
  expect(within(list).getAllByRole("option")).toHaveLength(61);
  fireEvent.change(programFilter, { target: { value: "program 4" } });
  expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(Array.from({ length: 10 }, (_, index) => `Program 4${index}`));
  fireEvent.keyDown(programFilter, { key: "ArrowDown" });
  fireEvent.keyDown(programFilter, { key: "Enter" });
  const url = new URL(navigation.replace.mock.lastCall![0], "http://localhost");
  expect(url.pathname).toBe("/admin/coaching/prices");
  // Other filters and the sort are kept; pagination restarts.
  expect(Object.fromEntries(url.searchParams)).toEqual({ scope: "club", sort: "amount", dir: "desc", program: many[41].id });
});

it("clears the program filter with All programs by mouse selection", async () => {
  navigation.query = `program=${program.id}`;
  lists.loadPricesPage.mockResolvedValue(pricesPageData({ program: program.id }, [program]));
  render(await AdminCoachingPricesPage({ searchParams: Promise.resolve({ program: program.id }) }));
  const programFilter = screen.getByRole("combobox", { name: "Program" }) as HTMLInputElement;
  expect(programFilter.value).toBe("Private lesson");
  fireEvent.click(programFilter);
  fireEvent.click(within(screen.getByRole("listbox", { name: "Program" })).getByRole("option", { name: "All programs" }));
  expect(navigation.replace).toHaveBeenLastCalledWith("/admin/coaching/prices", { scroll: false });
});

it("shows club price inputs grouped by location and currency for the selected durations", () => {
  render(<ProgramDialog program={program} locations={[central, riverside]} open onOpenChange={() => undefined}
    prices={[price({ amount_minor: 18000 }), price({ duration_minutes: 90, location_id: riverside.id, currency: "EUR", amount_minor: 24050 }),
      price({ coach_user_id: coach.user_id, amount_minor: 20000 })]} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  const centralPrices = within(dialog).getByRole("region", { name: "Club prices at Central Club" });
  const riversidePrices = within(dialog).getByRole("region", { name: "Club prices at Riverside Club" });
  expect(within(centralPrices).getByRole("heading").textContent).toBe("Central Club — RON");
  expect(within(riversidePrices).getByRole("heading").textContent).toBe("Riverside Club — EUR");
  // Existing club defaults are loaded; coach overrides are not editable here.
  expect((within(dialog).getByLabelText("60 min club price at Central Club") as HTMLInputElement).value).toBe("180.00");
  expect((within(dialog).getByLabelText("90 min club price at Central Club") as HTMLInputElement).value).toBe("");
  expect((within(dialog).getByLabelText("90 min club price at Central Club") as HTMLInputElement).placeholder).toBe("Not set");
  expect((within(dialog).getByLabelText("90 min club price at Riverside Club") as HTMLInputElement).value).toBe("240.50");
  expect(within(dialog).queryByText(/200\.00/)).toBeNull();
  // Adding a duration adds its price inputs; unselecting one hides them.
  fireEvent.click(within(dialog).getByLabelText("120 min"));
  expect(within(dialog).getByLabelText("120 min club price at Riverside Club")).toBeTruthy();
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  expect(within(dialog).queryByLabelText("90 min club price at Central Club")).toBeNull();
  fireEvent.input(within(dialog).getByLabelText("Other durations (minutes, comma-separated)"), { target: { value: "105" } });
  expect(within(dialog).getByLabelText("105 min club price at Central Club")).toBeTruthy();
});

it("creates a program with its submitted club prices, omitting empty prices", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog locations={[central, riverside]} />);
  fireEvent.click(screen.getByRole("button", { name: "Create program" }));
  const dialog = screen.getByRole("dialog", { name: "Create program" });
  fireEvent.input(within(dialog).getByLabelText("Name"), { target: { value: "Squad" } });
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  fireEvent.change(within(dialog).getByLabelText("60 min club price at Central Club"), { target: { value: "180" } });
  fireEvent.change(within(dialog).getByLabelText("90 min club price at Riverside Club"), { target: { value: " 240.5 " } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save program" }));
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledOnce());
  expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ fields: expect.objectContaining({ name: "Squad", durations: [60, 90] }),
    club_prices: [{ location_id: central.id, duration_minutes: 60, amount: "180" }, { location_id: riverside.id, duration_minutes: 90, amount: "240.5" }] });
  await expectToast("Program created.", "success");
});

it("saves only changed club prices and explicit removals when editing", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: true, id: program.id });
  render(<ProgramDialog program={program} locations={[central, riverside]} open onOpenChange={() => undefined}
    prices={[price({}), price({ duration_minutes: 90 }), price({ location_id: riverside.id, currency: "EUR", amount_minor: 5000 })]} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  const save = within(dialog).getByRole("button", { name: "Save program" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText("60 min club price at Central Club"), { target: { value: "185.50" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove Central Club 90 min club price" }));
  expect(within(dialog).getByText("Removed when you save.")).toBeTruthy();
  expect((within(dialog).getByLabelText("90 min club price at Central Club") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(save);
  await waitFor(() => expect(actions.saveCoachingProgramAction).toHaveBeenCalledWith({ id: program.id, fields: expect.objectContaining({ durations: [60, 90] }),
    club_prices: [{ location_id: central.id, duration_minutes: 60, amount: "185.50" }],
    removed_club_prices: [{ location_id: central.id, duration_minutes: 90 }] }));
});

it("never treats a cleared price as zero or a removal, and rejects invalid amounts beside the field", async () => {
  actions.saveCoachingProgramAction.mockResolvedValue({ ok: false, reason: "invalid-input", fieldErrors: { "club_prices.0": "Use a smaller amount." } });
  render(<ProgramDialog program={program} locations={[central]} prices={[price({})]} open onOpenChange={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  const save = within(dialog).getByRole("button", { name: "Save program" }) as HTMLButtonElement;
  const sixty = within(dialog).getByLabelText("60 min club price at Central Club") as HTMLInputElement;
  fireEvent.change(sixty, { target: { value: "" } });
  expect(within(dialog).getByText("Enter a price, or use Remove to clear it.")).toBeTruthy();
  expect(save.disabled).toBe(true);
  fireEvent.change(sixty, { target: { value: "-5" } });
  expect(within(dialog).getByText("Enter a positive amount with at most two decimal places.")).toBeTruthy();
  expect(sixty.getAttribute("aria-invalid")).toBe("true");
  expect(save.disabled).toBe(true);
  fireEvent.change(sixty, { target: { value: "123.45" } });
  fireEvent.click(save);
  // A server rejection is shown beside that price and the entered value is kept.
  expect(await within(dialog).findByText("Use a smaller amount.")).toBeTruthy();
  expect(sixty.value).toBe("123.45");
  expect(screen.getByRole("dialog", { name: "Edit program" })).toBeTruthy();
});

it("states which saved prices a removed duration deletes, and keeps them when reselected", () => {
  render(<ProgramDialog program={program} locations={[central]} open onOpenChange={() => undefined}
    prices={[price({ duration_minutes: 90 }), price({ duration_minutes: 90, coach_user_id: coach.user_id })]} />);
  const dialog = screen.getByRole("dialog", { name: "Edit program" });
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  expect(within(dialog).getByRole("status").textContent).toContain("Saving removes 90 min with 1 club price and 1 coach price");
  fireEvent.click(within(dialog).getByLabelText("90 min"));
  expect(within(dialog).queryByRole("status")).toBeNull();
  expect((within(dialog).getByLabelText("90 min club price at Central Club") as HTMLInputElement).value).toBe("180.00");
});
