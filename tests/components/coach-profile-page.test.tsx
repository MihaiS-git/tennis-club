// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicCoachProfile } from "@/lib/coaching/public";

const { readPublicCoach, listPublicLocationsWithCourts, notFound } = vi.hoisted(() => ({
  readPublicCoach: vi.fn(), listPublicLocationsWithCourts: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoach }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts }));

import CoachPage, { generateMetadata } from "@/app/coaching/coaches/[coachId]/page";
import { coachIntroduction } from "@/app/coaching/coaching-sections";

const coachId = "c1000000-0000-4000-8000-00000000000a";
const east = { id: "b1000000-0000-4000-8000-000000000001", name: "East Club" };
const west = { id: "b1000000-0000-4000-8000-000000000002", name: "West Club" };
const privateLesson = { id: "a1000000-0000-4000-8000-000000000001", name: "Private coaching", description: "One player, one coach.",
  type: "private" as const, durations: [60, 90], minParticipants: 1, maxParticipants: 1, courtRentalIncluded: true };
const coach: PublicCoachProfile = {
  id: coachId, displayName: "Ana Pop", bio: "Former junior champion. Coaches adults and juniors.\n\nAlso runs the doubles evenings.",
  qualifications: "Level 3 coach", specialties: ["Serve", "Doubles", "Footwork", "Fitness"], languages: ["Romanian", "English"],
  locations: [east, west], programs: [privateLesson],
  lessons: [
    { currency: "RON", programId: privateLesson.id, programName: privateLesson.name, durationMinutes: 60, participantCount: 1,
      price: { amountMinor: 25000, currency: "RON", source: "coach" } },
    { currency: "RON", programId: privateLesson.id, programName: privateLesson.name, durationMinutes: 90, participantCount: 1,
      price: { amountMinor: 28000, currency: "RON", source: "club" } },
    { currency: "EUR", programId: privateLesson.id, programName: privateLesson.name, durationMinutes: 60, participantCount: 1,
      price: { amountMinor: 5000, currency: "EUR", source: "club" } },
    { currency: "EUR", programId: privateLesson.id, programName: privateLesson.name, durationMinutes: 90, participantCount: 1, price: null },
  ],
};

const page = async (id = coachId) => render(await CoachPage({ params: Promise.resolve({ coachId: id }) }));
const priceRow = (currency: string, text: string) => within(screen.getByRole("region", { name: `Lesson prices in ${currency}` }))
  .getAllByRole("listitem").find((item) => item.textContent?.includes(text))!;

beforeEach(() => {
  listPublicLocationsWithCourts.mockResolvedValue([]);
  readPublicCoach.mockResolvedValue(coach);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("presents the public coach profile with valid in-page navigation", async () => {
  await page();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ana Pop");
  expect(screen.getByText("Serve · Doubles · Footwork", { exact: false })).toBeTruthy();
  expect(screen.getByText("Former junior champion. Coaches adults and juniors.")).toBeTruthy();
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual([
    "Meet Ana.", "What Ana teaches.", "Where Ana coaches.", "Lessons with Ana.",
  ]);
  const nav = screen.getByRole("navigation", { name: "On this page" });
  for (const link of within(nav).getAllByRole("link")) {
    expect(document.getElementById(link.getAttribute("href")!.slice(1))?.tagName).toBe("SECTION");
  }
  for (const link of screen.getAllByRole("link", { name: /All coaches/ })) expect(link.getAttribute("href")).toBe("/coaching#coaches");
  expect(readPublicCoach).toHaveBeenCalledWith(coachId, []);
});

it("shows qualifications, languages, programs and location links", async () => {
  await page();
  const about = document.getElementById("about")!;
  expect(about.textContent).toContain("Level 3 coach");
  expect(about.textContent).toContain("Romanian, English");
  expect(within(about).getByRole("list", { name: "Ana Pop’s specialties" }).children).toHaveLength(4);
  const programs = within(document.getElementById("programs")!).getByRole("list", { name: "Programs taught by Ana Pop" });
  expect(programs.textContent).toContain("60 min · 90 min");
  expect(programs.textContent).toContain("1 player");
  expect(programs.textContent).toContain("Court rental included");
  expect(screen.getByRole("link", { name: "Courts at West Club" }).getAttribute("href")).toBe(`/courts#location-${west.id}`);
  expect(screen.getByRole("link", { name: "Opening hours and directions for East Club" }).getAttribute("href")).toBe("/club#visit");
});

it("labels coach and club prices per currency and leaves missing prices unpublished", async () => {
  await page();
  expect(priceRow("RON", "60 min").textContent).toContain("Ana’s price");
  expect(priceRow("RON", "60 min").textContent).toMatch(/250[.,]00/);
  expect(priceRow("RON", "90 min").textContent).toContain("Club price");
  expect(priceRow("EUR", "60 min").textContent).toMatch(/€|EUR/);
  expect(priceRow("EUR", "90 min").textContent).toContain("Price not published");
});

it("lists a separate price for each number of players", async () => {
  const semi = { ...privateLesson, id: "a1000000-0000-4000-8000-000000000002", name: "Semi-private", type: "semi_private" as const,
    durations: [60], minParticipants: 2, maxParticipants: 3 };
  const lesson = (participantCount: number, price: PublicCoachProfile["lessons"][number]["price"]) =>
    ({ currency: "RON" as const, programId: semi.id, programName: semi.name, durationMinutes: 60, participantCount, price });
  readPublicCoach.mockResolvedValue({ ...coach, programs: [semi], lessons: [
    lesson(2, { amountMinor: 15000, currency: "RON", source: "club" }), lesson(3, null)] });
  await page();
  expect(priceRow("RON", "2 players").textContent).toMatch(/Semi-private · 60 min · 2 players.*150[.,]00/);
  expect(priceRow("RON", "3 players").textContent).toContain("Price not published");
});

it("links to the shared coaching timetable with the coach preselected", async () => {
  await page();
  expect(screen.getByRole("link", { name: "Book a lesson with Ana" }).getAttribute("href"))
    .toBe(`/book?mode=coaching&coach=${coachId}`);
});

it("returns 404 for unknown or non-public coaches", async () => {
  readPublicCoach.mockResolvedValue(null);
  await expect(page("not-a-coach")).rejects.toThrow("NEXT_NOT_FOUND");
  expect(notFound).toHaveBeenCalled();
  expect(await generateMetadata({ params: Promise.resolve({ coachId: "missing" }) })).toEqual({ title: "Coach not found | Tennis Club" });
});

it("shows an unavailable state when coaching cannot be loaded", async () => {
  readPublicCoach.mockRejectedValue(new Error("Unable to load coach."));
  await page();
  expect(screen.getByRole("alert").textContent).toContain("temporarily unavailable");
  expect(notFound).not.toHaveBeenCalled();
});

it("titles the page with the coach and a concise introduction", async () => {
  expect(await generateMetadata({ params: Promise.resolve({ coachId }) })).toEqual({
    title: "Ana Pop | Coaching | Tennis Club", description: "Former junior champion. Coaches adults and juniors.",
  });
  expect(coachIntroduction(`${"A long first sentence. ".repeat(3)}${"x".repeat(240)}`)).toBe("A long first sentence.");
  expect(coachIntroduction("")).toBe("");
});
