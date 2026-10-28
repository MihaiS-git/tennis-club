// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicVisitorLocation } from "@/lib/courts/public";

const mocks = vi.hoisted(() => ({ locations: vi.fn(), contact: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/lib/courts/public", () => ({ listPublicVisitorLocations: mocks.locations }));
vi.mock("@/lib/club/contact", () => ({ readPublicClubContact: mocks.contact }));

import ContactPage, { metadata } from "@/app/contact/page";
import { ContactLocations, groupOpeningHours } from "@/app/contact/contact-locations";
import { jsonLd, locationsStructuredData } from "@/app/contact/structured-data";

const open = (opens: number, closes: number) => [{ opens_at_minute: opens, closes_at_minute: closes }];
const week = (intervals: (weekday: number) => { opens_at_minute: number; closes_at_minute: number }[]) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, intervals: intervals(weekday) }));

const court = { id: "22222222-2222-4222-8222-222222222222", name: "Court 1", slug: "court-1", surface: "clay", environment: "outdoor", has_lighting: true } as const;
const east: PublicVisitorLocation = { id: "11111111-1111-4111-8111-111111111111", name: "East Club", slug: "east",
  address_line1: "1 Court Road", address_line2: null, city: "Cluj-Napoca", postal_code: "400000", country_code: "RO",
  timezone: "Europe/Bucharest", currency: "RON", allow_pay_at_club: true, courts: [court, { ...court, id: "33333333-3333-4333-8333-333333333333" }],
  todayOpeningHours: open(480, 1320), customer_cancellation_notice_minutes: 1440, cancellationNoticeMinutes: 1440,
  weekOpeningHours: week((day) => (day < 5 ? open(480, 1320) : open(540, 1440))) };
const west: PublicVisitorLocation = { ...east, id: "44444444-4444-4444-8444-444444444444", name: "West Club", courts: [court],
  address_line1: null, city: "Oradea", postal_code: null, country_code: null, weekOpeningHours: week((day) => (day === 0 ? [] : open(420, 1380))) };

afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("groups consecutive weekdays that share opening hours", () => {
  expect(groupOpeningHours(east.weekOpeningHours)).toEqual([
    { days: "Monday – Friday", hours: "08:00–22:00" },
    { days: "Saturday – Sunday", hours: "09:00–24:00" },
  ]);
  expect(groupOpeningHours(week((day) => (day === 2 ? [] : day === 4 ? [...open(480, 720), ...open(900, 1200)] : open(480, 720))))).toEqual([
    { days: "Monday – Tuesday", hours: "08:00–12:00" },
    { days: "Wednesday", hours: "Closed" },
    { days: "Thursday", hours: "08:00–12:00" },
    { days: "Friday", hours: "08:00–12:00, 15:00–20:00" },
    { days: "Saturday – Sunday", hours: "08:00–12:00" },
  ]);
});

it("lists every location with address, weekly hours, directions, booking and map selection", () => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  render(<ContactLocations locations={[east, west]} />);
  const [first, second] = within(screen.getByRole("list", { name: "Club locations" })).getAllByRole("listitem");
  expect(first.getAttribute("aria-current")).toBe("true");
  expect(first.querySelector("address")?.textContent).toBe("1 Court RoadCluj-Napoca, 400000Romania");
  expect(first.textContent).toContain("2 courts");
  expect([...first.querySelectorAll("dt")].map((term) => term.textContent)).toEqual(["Monday – Friday", "Saturday – Sunday"]);
  const directions = within(first).getByRole("link", { name: /Get directions/ });
  expect(directions.textContent).toContain("to East Club (opens in a new tab)");
  expect(directions.getAttribute("href")).toBe(
    `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent("1 Court Road, Cluj-Napoca, 400000, Romania").replace(/%20/g, "+")}`);
  expect(directions.getAttribute("target")).toBe("_blank");
  expect(within(first).getByRole("link", { name: /Book at East Club/ }).getAttribute("href")).toBe(`/book?location=${east.id}`);
  expect(within(first).getByText("Shown on map")).toBeTruthy();
  // An insufficient address offers no directions rather than a guessed place.
  expect(within(second).queryByRole("link", { name: /Get directions/ })).toBeNull();
  expect(second.textContent).toContain("MondayClosed");
  expect(within(second).getByRole("link", { name: /Show on map/ }).getAttribute("href")).toBe(`/contact?location=${west.id}`);
});

it("selects the requested location and never guesses a map for an insufficient address", () => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  render(<ContactLocations locations={[east, west]} requested={west.id} />);
  expect(screen.getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("true");
  expect(screen.getByText("A map is not available for West Club.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Show map/ })).toBeNull();
});

it("renders a single location without numbering or selection, and a missing key without a map", () => {
  render(<ContactLocations locations={[east]} />);
  expect(screen.queryByText("01")).toBeNull();
  expect(screen.queryByRole("link", { name: /Show on map/ })).toBeNull();
  expect(screen.getAllByRole("listitem")[0].getAttribute("aria-current")).toBeNull();
  expect(screen.getByText("Map unavailable.")).toBeTruthy();
});

it("renders empty and failure states", () => {
  render(<ContactLocations locations={[]} />);
  expect(screen.getByText("No club locations are currently open to the public.")).toBeTruthy();
  cleanup();
  render(<ContactLocations locations={null} />);
  expect(screen.getByText("Location information is currently unavailable.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("describes locations as structured data from stored facts only", () => {
  const data = locationsStructuredData([east, west], { contactEmail: "hello@example.com", contactPhone: "" });
  expect(data["@graph"][0]).toMatchObject({ "@type": "SportsActivityLocation", name: "East Club", email: "hello@example.com",
    address: { streetAddress: "1 Court Road", addressLocality: "Cluj-Napoca", postalCode: "400000", addressCountry: "RO" } });
  expect(data["@graph"][0]).not.toHaveProperty("telephone");
  expect(data["@graph"][0].openingHoursSpecification.at(-1)).toMatchObject({ dayOfWeek: "https://schema.org/Sunday", opens: "09:00", closes: "23:59" });
  expect(data["@graph"][1].address).toEqual({ "@type": "PostalAddress", addressLocality: "Oradea" });
  expect(jsonLd({ name: "</script>" })).not.toContain("</script>");
});

async function renderPage() {
  const stream = await renderToReadableStream(<ContactPage searchParams={Promise.resolve({})} />);
  await stream.allReady;
  return new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
}

it("shows configured contact details as call and email links, and hides empty ones", async () => {
  mocks.locations.mockResolvedValue([east]);
  mocks.contact.mockResolvedValue({ contactEmail: "hello@example.com", contactPhone: "+40 21 123 4567" });
  let html = await renderPage();
  expect(html.querySelector('a[href="tel:+40211234567"]')?.textContent).toBe("+40 21 123 4567");
  expect(html.querySelector('a[href="mailto:hello@example.com"]')?.textContent).toBe("hello@example.com");
  expect(JSON.parse(html.querySelector('script[type="application/ld+json"]')!.textContent!)["@graph"][0].telephone).toBe("+40 21 123 4567");
  expect(metadata.title).toBe("Contact | Tennis Club");
  mocks.contact.mockResolvedValue({ contactEmail: "", contactPhone: "" });
  html = await renderPage();
  expect(html.querySelector('a[href^="tel:"], a[href^="mailto:"]')).toBeNull();
  expect(html.body.textContent).toContain("book a court online");
  mocks.contact.mockRejectedValue(new Error("db"));
  mocks.locations.mockRejectedValue(new Error("db"));
  html = await renderPage();
  expect(html.body.textContent).toContain("Club contact details are currently unavailable");
  expect(html.body.textContent).toContain("Location information is currently unavailable.");
  expect(html.querySelector('script[type="application/ld+json"]')).toBeNull();
});

// Kept last: the visitor's choice to load Google Maps lasts for the rest of the visit.
it("loads Google Maps only after the visitor asks for it", () => {
  vi.stubEnv("GOOGLE_MAPS_EMBED_API_KEY", "key");
  render(<ContactLocations locations={[east, west]} />);
  expect(document.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Show map/ }));
  const frame = screen.getByTitle("Map showing East Club");
  expect(frame.getAttribute("src")).toContain("https://www.google.com/maps/embed/v1/place?key=key&q=1+Court+Road%2C+Cluj-Napoca");
});
