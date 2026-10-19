// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarControls } from "@/app/book/calendar-controls";
import { CoachingControls } from "@/app/book/coaching-controls";
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
afterEach(() => { cleanup(); push.mockClear(); });

it("switches court/coaching modes and clears incompatible choices on location changes", () => {
  render(<CalendarControls locations={[{ id: "one", name: "One" }, { id: "two", name: "Two" }]} locationId="one"
    date="2099-10-15" today="2099-10-15" coaching={{ program: "private", coach: "ana", duration: "90" }} />);
  expect(screen.getByRole("link", { name: "Court booking" }).getAttribute("href")).toBe("/book");
  expect(screen.getByRole("link", { name: "Coaching" }).getAttribute("aria-current")).toBe("page");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  const dateUrl = new URL(push.mock.calls.at(-1)![0], "http://localhost");
  expect(Object.fromEntries(dateUrl.searchParams)).toEqual({ location: "one", mode: "coaching", program: "private", coach: "ana", duration: "90", date: "2099-10-16" });
  fireEvent.change(screen.getByRole("combobox", { name: "Location" }), { target: { value: "two" } });
  expect(new URL(push.mock.calls.at(-1)![0], "http://localhost").search).toBe("?location=two&mode=coaching");
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
