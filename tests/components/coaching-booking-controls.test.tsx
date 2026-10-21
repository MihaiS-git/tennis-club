// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarControls } from "@/app/book/calendar-controls";
import { CoachingControls } from "@/app/book/coaching-controls";
const { push, replace, refresh } = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace, refresh }) }));
afterEach(() => { cleanup(); push.mockClear(); replace.mockClear(); refresh.mockClear(); window.history.replaceState(null, "", "/book"); });

it("switches court/coaching modes and preserves choices for server revalidation on location changes", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }, { id: "two", name: "Two" }]} locationId="one"
    date="2099-10-15" today="2099-10-15" coaching={{ program: "private", coach: "ana", duration: "90" }} />);
  expect(screen.getByRole("link", { name: "Court booking" }).getAttribute("href")).toBe("/book");
  expect(screen.getByRole("link", { name: "Coaching" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  const dateUrl = new URL(push.mock.calls.at(-1)![0], "http://localhost");
  expect(Object.fromEntries(dateUrl.searchParams)).toEqual({ location: "one", mode: "coaching", program: "private", coach: "ana", duration: "90", date: "2099-10-16" });
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "two" } });
  expect(new URL(push.mock.calls.at(-1)![0], "http://localhost").search).toBe("?location=two&mode=coaching&program=private&coach=ana&duration=90");
});

it.each(["Program", "Coach", "Lesson duration"])("updates %s and drops dependent selections", label => {
  render(<CoachingControls locationId="one" date="2099-10-15" programId="private" coachId="ana" durationMinutes={60}
    programs={[{ id: "private", name: "Private" }, { id: "technique", name: "Technique" }]}
    coaches={[{ id: "ana", displayName: "Ana" }, { id: "dan", displayName: "Dan" }]} durations={[60, 90]} />);
  fireEvent.change(screen.getByRole("combobox", { name: label }), { target: { value: label === "Program" ? "technique" : label === "Coach" ? "dan" : "90" } });
  const params = new URL(push.mock.calls[0][0], "http://localhost").searchParams;
  expect(params.get("mode")).toBe("coaching");
  expect(params.get("date")).toBe("2099-10-15");
  if (label === "Program") { expect(params.get("coach")).toBe("ana"); expect(params.get("duration")).toBeNull(); }
  if (label === "Coach") expect(params.get("duration")).toBeNull();
  if (label === "Lesson duration") expect(params.get("duration")).toBe("90");
});


it("lists configured programs without a redundant placeholder", () => {
  render(<CoachingControls locationId="one" date="2099-10-15" programId="semi" coachId="ana" durationMinutes={90}
    programs={[{ id: "private", name: "Private coaching" }, { id: "semi", name: "Semi-private coaching" }]}
    coaches={[{ id: "ana", displayName: "Ana" }]} durations={[60, 90]} />);
  const select = screen.getByRole("combobox", { name: "Program" }) as HTMLSelectElement;
  expect([...select.options].map(option => option.text)).toEqual(["Private coaching", "Semi-private coaching"]);
  expect(select.value).toBe("semi");
});

it("cleans an ineligible URL coach with replace and never renders that coach as an option", () => {
  render(<CoachingControls locationId="central" date="2026-10-20" programId="private" coachId="" durationMinutes={0}
    programs={[{ id: "private", name: "Private" }]} coaches={[]} durations={[]}
    invalidCoachUrl="/book?mode=coaching&location=central&program=private" />);
  expect(screen.getByRole("combobox", { name: "Coach" }).textContent).toBe("Choose a coach");
  expect(replace).toHaveBeenCalledWith("/book?mode=coaching&location=central&program=private", { scroll: false });
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

it("allows recovery from an invalid date using the same clear action", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }]} locationId="one" date={null} today="2026-10-20" coaching={{ coach: "invalid" }} />);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(push).toHaveBeenCalledWith("/book?mode=coaching");
});
