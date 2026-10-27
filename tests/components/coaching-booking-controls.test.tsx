// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarControls } from "@/app/book/calendar-controls";
import { CoachingControls } from "@/app/book/coaching-controls";
const { push, replace, refresh } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace, refresh }) }));
afterEach(() => { cleanup(); push.mockClear(); replace.mockClear(); refresh.mockClear(); window.history.replaceState(null, "", "/book"); });

const club = (amountMinor: number) => ({ amountMinor, currency: "RON" as const, source: "club" as const });
const controls = (props: Partial<Parameters<typeof CoachingControls>[0]> = {}) => render(<CoachingControls locationId="one" date="2099-10-15"
  coaches={[{ id: "ana", displayName: "Ana" }, { id: "dan", displayName: "Dan" }]} coachId="ana" programId="private" durationMinutes={60}
  programs={[{ id: "private", name: "Private" }, { id: "technique", name: "Technique" }]} participants={{ min: 1, max: 4 }} participantCount={1}
  durations={[{ durationMinutes: 60, price: club(20000) }, { durationMinutes: 90, price: { amountMinor: 35000, currency: "RON", source: "coach" } }]}
  courtRentalIncluded={false} {...props} />);
const lastPush = () => Object.fromEntries(new URL(push.mock.calls.at(-1)![0], "http://localhost").searchParams);

it("keeps lesson choices on date changes and clears them on location changes", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }, { id: "two", name: "Two" }]} locationId="one"
    date="2099-10-15" today="2099-10-15" coaching={{ program: "private", coach: "ana", duration: "90" }} />);
  expect(screen.getByRole("link", { name: "Court booking" }).getAttribute("href")).toBe("/book");
  expect(screen.getByRole("link", { name: "Coaching" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(lastPush()).toEqual({ location: "one", mode: "coaching", program: "private", coach: "ana", duration: "90", date: "2099-10-16" });
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "two" } });
  expect(lastPush()).toEqual({ location: "two", mode: "coaching" });
});

it("clears lesson choices when recovering from an invalid location", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }, { id: "two", name: "Two" }]} date={null} today="" coaching={{ coach: "ana" }} />);
  const location = screen.getByRole("combobox", { name: "Location" }) as HTMLSelectElement;
  expect(location.value).toBe("");
  expect([...location.options].map(option => option.text)).toEqual(["Choose a location", "One", "Two"]);
  expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();
  fireEvent.change(location, { target: { value: "two" } });
  expect(lastPush()).toEqual({ location: "two", mode: "coaching" });
});

it.each([
  ["Coach", "dan", { coach: "dan" }],
  ["Program", "technique", { coach: "ana", program: "technique" }],
  ["Lesson duration", "90", { coach: "ana", program: "private", duration: "90", participants: "1" }],
  ["Players", "3", { coach: "ana", program: "private", duration: "60", participants: "3" }],
] as const)("changing %s sends only the valid upstream selections for server defaults", (label, value, expected) => {
  controls();
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value } });
  expect(lastPush()).toEqual({ mode: "coaching", location: "one", date: "2099-10-15", ...expected });
});

it("renders resolved defaults without navigation or a selected time", () => {
  controls();
  expect((screen.getByRole("combobox", { name: "Coach" }) as HTMLSelectElement).value).toBe("ana");
  expect((screen.getByRole("combobox", { name: "Program" }) as HTMLSelectElement).value).toBe("private");
  expect((screen.getByRole("combobox", { name: "Lesson duration" }) as HTMLSelectElement).value).toBe("60");
  expect((screen.getByRole("combobox", { name: "Players" }) as HTMLSelectElement).value).toBe("1");
  expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole("region", { name: "Selected interval" })).toBeNull();
});

it("orders Coach → Program → Duration → Players and disables each selector until its prerequisite is chosen", () => {
  controls({ coachId: "", programId: "", durationMinutes: 0, programs: [], durations: [], participants: null, participantCount: 0 });
  expect(screen.getAllByRole("combobox").map(select => select.getAttribute("aria-label"))).toEqual(["Coach", "Program", "Lesson duration", "Players"]);
  expect((screen.getByRole("combobox", { name: "Players" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("combobox", { name: "Players" }).textContent).toBe("Choose a program first");
  expect((screen.getByRole("combobox", { name: "Coach" }) as HTMLSelectElement).disabled).toBe(false);
  expect((screen.getByRole("combobox", { name: "Program" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("combobox", { name: "Program" }).textContent).toBe("Choose a coach first");
  expect((screen.getByRole("combobox", { name: "Lesson duration" }) as HTMLSelectElement).disabled).toBe(true);
  cleanup();
  controls({ coaches: [], coachId: "", programId: "", durationMinutes: 0, programs: [], durations: [] });
  expect((screen.getByRole("combobox", { name: "Coach" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("combobox", { name: "Coach" }).textContent).toBe("No coaches at this location");
});

it("lists every assigned program as selectable, whatever its type", () => {
  controls({ programId: "", durationMinutes: 0, durations: [], participants: null, participantCount: 0,
    programs: [{ id: "private", name: "Private" }, { id: "group", name: "Group" }, { id: "junior", name: "Junior" }] });
  const options = [...(screen.getByRole("combobox", { name: "Program" }) as HTMLSelectElement).options];
  expect(options.map(option => [option.text, option.disabled])).toEqual([["Choose a program", true], ["Private", false], ["Group", false], ["Junior", false]]);
  cleanup();
  controls({ programId: "", durationMinutes: 0, durations: [], programs: [] });
  expect((screen.getByRole("combobox", { name: "Program" }) as HTMLSelectElement).disabled).toBe(true);
  expect(screen.getByRole("combobox", { name: "Program" }).textContent).toBe("No programs assigned");
});

it("offers exactly the program's configured participant counts", () => {
  controls({ programId: "group", participants: { min: 3, max: 6 }, participantCount: 0 });
  const players = screen.getByRole("combobox", { name: "Players" }) as HTMLSelectElement;
  expect(players.value).toBe("");
  expect([...players.options].map(option => option.text)).toEqual(["Choose the number of players", "3 players", "4 players", "5 players", "6 players"]);
  cleanup();
  controls({ participants: { min: 1, max: 1 }, participantCount: 1 });
  expect([...(screen.getByRole("combobox", { name: "Players" }) as HTMLSelectElement).options].map(option => option.text)).toEqual(["Choose the number of players", "1 player"]);
});

it("shows each duration's effective price, the selected price source and court rental terms", () => {
  controls({ durations: [{ durationMinutes: 60, price: club(20000) }, { durationMinutes: 90, price: null }] });
  expect([...(screen.getByRole("combobox", { name: "Lesson duration" }) as HTMLSelectElement).options].map(option => option.text.replace(/\s/g, " ")))
    .toEqual(["Choose a lesson length", "60 min · RON 200.00", "90 min · price unavailable"]);
  expect(screen.getByText(/Coaching price:/).textContent?.replace(/\s/g, " ")).toBe("Coaching price: RON 200.00 (club price) · Court rental charged separately at the court’s rate");
  cleanup();
  controls({ durationMinutes: 90, courtRentalIncluded: true });
  expect(screen.getByText(/Coaching price:/).textContent?.replace(/\s/g, " ")).toBe("Coaching price: RON 350.00 (coach’s price) · Court rental included");
  cleanup();
  controls({ durations: [{ durationMinutes: 60, price: null }] });
  expect(screen.queryByText(/Coaching price:/)).toBeNull();
});

it("exposes Clear filters in coaching mode and navigates to initialization defaults with clean URL state", () => {
  window.history.replaceState(null, "", "/book?mode=coaching&location=two&date=2099-10-15&program=semi&coach=stale&duration=90");
  render(<CalendarControls locations={[{ id: "one", name: "One" }, { id: "two", name: "Two" }]} locationId="two"
    date="2099-10-15" today="2026-10-20" coaching={{ program: "semi", coach: "stale", duration: "90" }} />);
  const clear = screen.getByRole("button", { name: "Clear filters" });
  expect(clear.getAttribute("type")).toBe("button");
  fireEvent.click(clear);
  expect(push).toHaveBeenCalledExactlyOnceWith("/book?mode=coaching");
  expect(refresh).not.toHaveBeenCalled();
  expect(Object.fromEntries(new URL(push.mock.calls[0][0], "http://localhost").searchParams)).toEqual({ mode: "coaching" });
});

it("refreshes availability when already on the default Coaching URL", () => {
  window.history.replaceState(null, "", "/book?mode=coaching");
  render(<CalendarControls locations={[{ id: "one", name: "One" }]} locationId="one" date="2026-10-20" today="2026-10-20" coaching={{}} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled();
});

it("does not show the coaching reset in court-booking mode", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }]} locationId="one" date="2026-10-20" today="2026-10-20" />);
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

it("reserves the Clear filters slot so switching booking mode keeps the other calendar controls fixed", () => {
  const props = { locations: [{ id: "one", name: "One" }], locationId: "one", date: "2026-10-20", today: "2026-10-20" };
  // Every element outside the slot (and its classes) must be identical with and without Clear.
  const layout = (container: HTMLElement) => [...container.querySelectorAll(":not(option)")]
    .filter((element) => !element.closest("[data-filter-clear-slot]")).map((element) => `${element.tagName}.${element.getAttribute("class") ?? ""}`);
  const { container, rerender } = render(<CalendarControls {...props} />);
  const slot = container.querySelector("[data-filter-clear-slot]")!;
  expect(slot.children).toHaveLength(0);
  const courtLayout = layout(container);

  rerender(<CalendarControls {...props} coaching={{ coach: "ana" }} />);
  const clear = screen.getByRole("button", { name: "Clear filters" });
  expect(container.querySelector("[data-filter-clear-slot]")).toBe(slot);
  expect(slot.contains(clear)).toBe(true);
  expect(layout(container)).toEqual(courtLayout);

  rerender(<CalendarControls {...props} />);
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  expect(container.querySelector("[data-filter-clear-slot]")).toBe(slot);
  expect(layout(container)).toEqual(courtLayout);
});

it("allows recovery from an invalid date using the same clear action", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }]} locationId="one" date={null} today="2026-10-20" coaching={{ coach: "invalid" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(push).toHaveBeenCalledWith("/book?mode=coaching");
});
