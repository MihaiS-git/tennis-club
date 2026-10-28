// @vitest-environment jsdom
import { renderToReadableStream } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: async () => [] }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching: async () => ({ programs: [], coaches: [] }) }));
vi.mock("@/app/home-court-availability", () => ({ CourtAvailabilityCard: () => null, CourtAvailabilityCardShell: () => null }));
vi.mock("@/app/home-court-summary", () => ({ FacilitiesCourtsFallback: () => null, FacilitiesCourtsSummary: () => null,
  HeroCourtSummary: () => null, heroSummaryClassName: "" }));
vi.mock("@/app/home-coaching", () => ({ HomeCoachingFallback: () => null, HomeCoachingPrograms: () => null }));
vi.mock("@/app/home-locations", () => ({ HomeLocations: () => null, HomeLocationsShell: () => null }));

import Home from "@/app/page";

it("preloads exactly the mobile AVIF candidates the native hero picture will select", async () => {
  const stream = await renderToReadableStream(<Home params={Promise.resolve({})} searchParams={Promise.resolve({})} />);
  await stream.allReady;
  const html = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  const preloads = html.querySelectorAll('link[rel="preload"][as="image"]');
  expect(preloads.length).toBe(2);
  const preload = preloads[0];
  const hero = html.querySelector("picture")!;
  const source = hero.querySelector('source[type="image/avif"]:not([media])')!;
  expect(preload.getAttribute("type")).toBe("image/avif");
  expect(preload.getAttribute("media")).toBe("(max-width: 1023px)");
  expect(preload.getAttribute("imagesrcset")).toBe(source.getAttribute("srcset"));
  expect(preload.getAttribute("imagesizes")).toBe(source.getAttribute("sizes"));
  expect(preload.getAttribute("fetchpriority")).toBe("high");
  const desktop = hero.querySelector('source[type="image/avif"][media]')!;
  expect(preloads[1].getAttribute("media")).toBe(desktop.getAttribute("media"));
  expect(preloads[1].getAttribute("imagesrcset")).toBe(desktop.getAttribute("srcset"));
  expect(preloads[1].getAttribute("imagesizes")).toBe(desktop.getAttribute("sizes"));
  expect(hero.querySelector("img")!.getAttribute("loading")).toBe("eager");
});
