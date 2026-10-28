// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PublicLocationToday } from "@/lib/courts/public-calendar";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public-calendar", () => ({ listPublicLocationsToday: load }));
import CourtsPage from "@/app/courts/page";

afterEach(() => { document.body.replaceChildren(); });

// Resolve the complete Server Component tree before inspecting its HTML. The client
// renderer cannot resolve async Server Component children beneath Suspense, and an
// unlimited chunk size keeps every resolved boundary inline rather than outlined.
async function renderPage() {
  const stream = await renderToReadableStream(<CourtsPage />, { progressiveChunkSize: Infinity });
  await stream.allReady;
  const html = new DOMParser().parseFromString(await new Response(stream).text(), "text/html");
  document.body.innerHTML = html.body.innerHTML;
  return html;
}

const location = {
  id: "11111111-1111-4111-8111-111111111111", name: "Riverside", slug: "riverside", timezone: "Europe/Bucharest",
  currency: "RON", allow_pay_at_club: false, customer_cancellation_notice_minutes: null, address_line1: null, address_line2: null,
  city: null, postal_code: null, country_code: null, todayOpeningHours: [], openingHours: [], startingRateMinor: null,
  courts: [{ id: "22222222-2222-4222-8222-222222222222", name: "Clay One", slug: "clay-one", surface: "clay", environment: "outdoor", has_lighting: false }],
} satisfies PublicLocationToday;

const sourcesOf = (image: HTMLElement) => [...image.parentElement!.querySelectorAll("source")];
const urls = (srcSet: string | null) => srcSet!.split(", ").map((candidate) => candidate.split(" ")[0]);

it("serves the hero as a prioritized native picture with pre-sized, art-directed AVIF", async () => {
  load.mockResolvedValue([]);
  await renderPage();
  const hero = screen.getByRole("img", { name: "Clay tennis court at sunset, with rackets and balls beside the court" });
  expect(hero.tagName).toBe("IMG");
  expect(hero.parentElement!.tagName).toBe("PICTURE");
  expect(hero.getAttribute("src")).not.toContain("/_next/image");
  expect(hero.getAttribute("loading")).toBe("eager");
  expect(hero.getAttribute("fetchpriority")).toBe("high");
  expect(hero.className).toContain("object-[30%_center] md:object-[center_60%]");
  const [narrowAvif, narrowWebp, portraitAvif, portraitWebp, wideAvif] = sourcesOf(hero);
  expect(narrowAvif.getAttribute("media")).toBe(narrowWebp.getAttribute("media"));
  expect(urls(narrowAvif.getAttribute("srcset"))).toEqual([
    "/images/courts/tennis-courts-public-narrow-427.avif", "/images/courts/tennis-courts-public-narrow-627.avif",
  ]);
  expect(portraitAvif.getAttribute("media")).toBe(portraitWebp.getAttribute("media"));
  expect(portraitAvif.getAttribute("media")).toContain("max-width: 767px");
  expect(urls(portraitAvif.getAttribute("srcset"))).toEqual([
    "/images/courts/tennis-courts-public-portrait-640.avif", "/images/courts/tennis-courts-public-portrait-941.avif",
  ]);
  expect(wideAvif.getAttribute("media")).toBeNull();
  expect(wideAvif.getAttribute("type")).toBe("image/avif");
  for (const source of [portraitAvif, portraitWebp, wideAvif]) expect(source.getAttribute("sizes")).toBeTruthy();
  expect(urls(hero.getAttribute("srcset")).every((url) => url.endsWith(".webp"))).toBe(true);
});

it("lazy-loads below-the-fold photographs from responsive candidates", async () => {
  load.mockResolvedValue([location]);
  await renderPage();
  for (const name of [/backhand on a clay court/, /sliding into a forehand/]) {
    const image = screen.getByRole("img", { name });
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("sizes")).toBeTruthy();
    expect(urls(image.getAttribute("srcset")).length).toBeGreaterThan(1);
    const [avif] = sourcesOf(image);
    expect(avif.getAttribute("type")).toBe("image/avif");
    expect(urls(avif.getAttribute("srcset")).every((url) => url.startsWith("/images/courts/") && url.endsWith(".avif"))).toBe(true);
  }
});

it("hoists mutually exclusive AVIF preloads matching the portrait and wide hero sources", async () => {
  load.mockResolvedValue([]);
  const html = await renderPage();
  const preloads = [...html.head.querySelectorAll('link[rel="preload"][as="image"]')];
  const sources = [...html.querySelectorAll('picture source[type="image/avif"]')];
  expect(preloads).toHaveLength(3);
  expect(preloads[0].getAttribute("media")).toBe(sources[0].getAttribute("media"));
  expect(preloads[1].getAttribute("media")).toContain(`not (${sources[0].getAttribute("media")})`);
  expect(preloads[2].getAttribute("media")).toContain(`not (${sources[1].getAttribute("media")})`);
  for (const [index, preload] of preloads.entries()) {
    expect(preload.getAttribute("type")).toBe("image/avif");
    expect(preload.getAttribute("fetchpriority")).toBe("high");
    expect(preload.getAttribute("imagesrcset")).toBe(sources[index].getAttribute("srcset"));
    expect(preload.getAttribute("imagesizes")).toBe(sources[index].getAttribute("sizes"));
  }
});
