// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicCoachProfile } from "@/lib/coaching/public";

const { readPublicCoach, readCoachBookableLocationIds, listPublicLocationsWithCourts, notFound } = vi.hoisted(() => ({
  readPublicCoach: vi.fn(), readCoachBookableLocationIds: vi.fn(), listPublicLocationsWithCourts: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }),
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoach }));
vi.mock("@/lib/coaching/booking-options", () => ({ readCoachBookableLocationIds }));
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
  // Ana teaches at both clubs but has online-bookable lessons only at West Club.
  readCoachBookableLocationIds.mockResolvedValue([west.id]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("presents the public coach profile with valid in-page navigation", async () => {
  await page();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ana Pop");
  expect(screen.getByText("Serve · Doubles · Footwork", { exact: false })).toBeTruthy();
  // The hero carries a one-sentence lede; only About shows the complete biography.
  const hero = screen.getByRole("region", { name: "Ana Pop" });
  expect(within(hero).getByText("Former junior champion.")).toBeTruthy();
  expect(hero.textContent).not.toContain("Also runs the doubles evenings.");
  expect(document.getElementById("about")!.textContent).toContain(coach.bio);
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
  expect(screen.getByRole("link", { name: "Opening hours and directions for East Club" }).getAttribute("href")).toBe(`/contact?location=${east.id}`);
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

it("omits the hero lede when the biography is a single sentence", async () => {
  readPublicCoach.mockResolvedValue({ ...coach, bio: "Former junior champion." });
  await page();
  expect(screen.getByRole("region", { name: "Ana Pop" }).textContent).not.toContain("Former junior champion.");
  expect(document.getElementById("about")!.textContent).toContain("Former junior champion.");
});

it("orders programs by type and marks Group/Junior programs as arranged off-line", async () => {
  const program = (n: number, type: "private" | "semi_private" | "group" | "junior", name: string) =>
    ({ ...privateLesson, id: `a1000000-0000-4000-8000-00000000001${n}`, type, name });
  readPublicCoach.mockResolvedValue({ ...coach, programs: [
    program(1, "junior", "Junior academy"), program(2, "group", "Cardio tennis"), program(3, "semi_private", "Pairs"), program(4, "private", "One-to-one"),
    program(5, "group", "Doubles drills")] });
  await page();
  const items = within(screen.getByRole("list", { name: "Programs taught by Ana Pop" })).getAllByRole("listitem");
  expect(items.map((item) => item.querySelector("h3")!.textContent)).toEqual(["One-to-one", "Pairs", "Cardio tennis", "Doubles drills", "Junior academy"]);
  // An odd last program spans the full width instead of leaving an empty column.
  expect(items.map((item) => item.className.includes("md:col-span-2"))).toEqual([false, false, false, false, true]);
  for (const item of items.slice(0, 2)) expect(item.textContent).not.toContain("not booked online");
  for (const item of items.slice(2)) {
    expect(item.textContent).toContain("Arranged through Ana or the club, not booked online.");
    const name = item.querySelector("h3")!.textContent;
    expect(within(item).getByRole("link", { name: `Contact the club about ${name}` }).getAttribute("href")).toBe("/contact");
  }
});

it("links to the shared coaching timetable with the coach preselected at a bookable location", async () => {
  await page();
  const href = `/book?mode=coaching&location=${west.id}&coach=${coachId}`;
  expect(within(screen.getByRole("region", { name: "Ana Pop" })).getByRole("link", { name: "Book a lesson" }).getAttribute("href")).toBe(href);
  expect(screen.getByRole("link", { name: "Book a lesson with Ana" }).getAttribute("href")).toBe(href);
  expect(readCoachBookableLocationIds).toHaveBeenCalledWith(coachId, []);
  expect(screen.queryByRole("link", { name: "Contact the club" })).toBeNull();
});

it("directs visitors to the club instead of online booking for a coach without online-bookable lessons", async () => {
  // E.g. a coach assigned only Group/Junior programs, who stays publicly discoverable.
  readCoachBookableLocationIds.mockResolvedValue([]);
  await page();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ana Pop");
  expect(screen.queryByRole("link", { name: /Book a lesson/ })).toBeNull();
  expect(screen.getByText(/Sessions with Ana are not booked online/).textContent).toContain("Contact the club to arrange one.");
  const contacts = screen.getAllByRole("link", { name: "Contact the club" });
  expect(contacts).toHaveLength(2);
  expect(within(screen.getByRole("region", { name: "Ana Pop" })).getByRole("link", { name: "Contact the club" })).toBe(contacts[0]);
  for (const link of contacts) expect(link.getAttribute("href")).toBe("/contact");
});

it("suggests neither booking nor contact when online bookability cannot be determined", async () => {
  readCoachBookableLocationIds.mockRejectedValue(new Error("Unavailable"));
  await page();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Ana Pop");
  expect(screen.queryByRole("link", { name: /Book a lesson/ })).toBeNull();
  expect(screen.queryByRole("link", { name: "Contact the club" })).toBeNull();
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
    alternates: { canonical: `/coaching/coaches/${coachId}` },
  });
  expect(coachIntroduction(`${"A long first sentence. ".repeat(3)}${"x".repeat(240)}`)).toBe("A long first sentence.");
  expect(coachIntroduction("")).toBe("");
});
