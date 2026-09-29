// @vitest-environment jsdom

import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PublicLocation } from "../../src/lib/courts/public";

const { listActiveLocationsWithCourts } = vi.hoisted(() => ({
  listActiveLocationsWithCourts: vi.fn<() => Promise<PublicLocation[]>>(),
}));

vi.mock("@/lib/courts/public", () => ({ listActiveLocationsWithCourts }));

import CourtsPage from "../../src/app/courts/page";

const locations: PublicLocation[] = [
  {
    id: "central", name: "Central Club", slug: "central",
    address_line1: "Park Street 10", address_line2: "East entrance",
    city: "Cluj-Napoca", postal_code: "400000", country_code: "RO",
    timezone: "Europe/Bucharest",
    courts: [
      { id: "one", name: "Court One", slug: "one", surface: "clay", environment: "outdoor", has_lighting: true },
      { id: "two", name: "Court Two", slug: "two", surface: "hard", environment: "indoor", has_lighting: false },
    ],
  },
  {
    id: "north", name: "North Club", slug: "north",
    address_line1: null, address_line2: null, city: null, postal_code: null, country_code: null,
    timezone: "Europe/Bucharest",
    courts: [
      { id: "three", name: "Court Three", slug: "three", surface: "grass", environment: "outdoor", has_lighting: false },
    ],
  },
];

function renderPage(onChunk?: (html: string) => void): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    let html = "";
    output.on("data", (chunk: Buffer) => {
      html += chunk.toString();
      onChunk?.(html);
    });
    output.on("end", () => {
      const container = document.createElement("div");
      container.innerHTML = html;
      document.body.append(container);
      resolve(container);
    });
    output.on("error", reject);
    const stream = renderToPipeableStream(<CourtsPage />, {
      onShellReady() { if (onChunk) stream.pipe(output); },
      onAllReady() { if (!onChunk) stream.pipe(output); },
      onError: reject,
    });
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  listActiveLocationsWithCourts.mockResolvedValue(locations);
});

afterEach(() => { document.body.replaceChildren(); });

it("renders the public court count and groups court details under each location", async () => {
  const page = within(await renderPage());
  expect(page.getByText("3 courts")).toBeTruthy();
  expect(page.getByText(/across 2 locations/)).toBeTruthy();
  const central = within(page.getByRole("article", { name: "Central Club" }));
  const north = within(page.getByRole("article", { name: "North Club" }));
  expect(central.getByRole("heading", { name: "Court One" })).toBeTruthy();
  expect(central.getByRole("heading", { name: "Court Two" })).toBeTruthy();
  expect(central.queryByText("Court Three")).toBeNull();
  expect(north.getByRole("heading", { name: "Court Three" })).toBeTruthy();
  for (const label of ["Clay", "Hard", "Outdoor", "Indoor"]) expect(central.getByText(label)).toBeTruthy();
  expect(north.getByText("Grass")).toBeTruthy();
  expect(north.getByText("Outdoor")).toBeTruthy();
  expect(central.getAllByText("Floodlit")).toHaveLength(1);
  expect(north.queryByText("Floodlit")).toBeNull();
  expect(listActiveLocationsWithCourts).toHaveBeenCalledExactlyOnceWith();
});

it("shows only supplied addresses and confirmed equipment information", async () => {
  const container = await renderPage();
  const page = within(container);
  for (const line of ["Park Street 10", "East entrance", "Cluj-Napoca, 400000", "RO"]) {
    expect(page.getByText(line)).toBeTruthy();
  }
  expect(page.getByRole("article", { name: "North Club" }).querySelector("address")).toBeNull();
  expect(page.getByRole("heading", { name: "Rackets and balls available" })).toBeTruthy();
  expect(container.textContent).not.toMatch(/Europe\/Bucharest|showers|parking|changing rooms|restaurant|memberships|supports_balloon|balloon_installed/i);
});

it("shows temporary public opening hours and the hourly starting price", async () => {
  const page = within(await renderPage());
  expect(page.getByText("Open daily 07:00–24:00")).toBeTruthy();
  expect(page.getByText("From €10/hour")).toBeTruthy();
});

it("shows the stored environment without a temporary coverage state", async () => {
  listActiveLocationsWithCourts.mockResolvedValue([{
    ...locations[1], courts: [{ ...locations[1].courts[0] }],
  }]);
  const page = within(await renderPage());
  expect(page.getByText("Outdoor")).toBeTruthy();
  expect(page.queryByText("Balloon covered")).toBeNull();
});

it.each([{ emptyLocations: [] }, { emptyLocations: [{ ...locations[0], courts: [] }] }])("handles empty court discovery while preserving the public shell", async ({ emptyLocations }) => {
  listActiveLocationsWithCourts.mockResolvedValue(emptyLocations);
  const page = within(await renderPage());
  expect(page.getByText("Court information is currently unavailable. Please check back soon.")).toBeTruthy();
  expect(page.getByRole("heading", { level: 1, name: "Clay courts, ready to play." })).toBeTruthy();
  expect(page.getByRole("heading", { name: "Rackets and balls available" })).toBeTruthy();
  expect(page.queryByRole("article")).toBeNull();
  expect(page.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
});

it("uses the dedicated courts photograph and preserves the existing booking target", async () => {
  const container = await renderPage();
  const page = within(container);
  const photo = page.getByRole("img", { name: "Clay tennis court at sunset, with rackets and balls beside the court" });
  expect(photo.getAttribute("src")).toBe("/images/tennis-courts-public.webp");
  expect(container.querySelector('source[type="image/avif"]')?.getAttribute("srcset")).toBe("/images/tennis-courts-public.avif");
  expect(container.querySelector('source[type="image/webp"]')?.getAttribute("srcset")).toBe("/images/tennis-courts-public.webp");
  expect(page.getByRole("link", { name: "Book a court" }).getAttribute("href")).toBe("/book");
});

it("streams the static shell while court discovery is pending", async () => {
  let resolveDiscovery: (value: PublicLocation[]) => void = () => {};
  listActiveLocationsWithCourts.mockReturnValue(new Promise((resolve) => { resolveDiscovery = resolve; }));
  let shell = "";
  await renderPage((html) => {
    if (!shell && html.includes("Ready to play?")) {
      shell = html;
      resolveDiscovery(locations);
    }
  });
  const container = document.createElement("div");
  container.innerHTML = shell;
  document.body.append(container);
  const page = within(container);
  expect(page.getByRole("heading", { level: 1, name: "Clay courts, ready to play." })).toBeTruthy();
  expect(page.getByRole("status").textContent).toBe("Loading court information…");
  expect(page.getByRole("heading", { name: "Rackets and balls available" })).toBeTruthy();
  expect(page.getByRole("link", { name: "Book a court" })).toBeTruthy();
  expect(page.queryByRole("article")).toBeNull();
});
