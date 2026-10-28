import { afterEach, expect, it, vi } from "vitest";

const { readPublicCoaching } = vi.hoisted(() => ({ readPublicCoaching: vi.fn() }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: async () => [] }));
vi.mock("@/lib/coaching/public", () => ({ readPublicCoaching }));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

afterEach(() => vi.unstubAllEnvs());

const publicPages = ["/", "/courts", "/coaching", "/pricing", "/club", "/contact", "/book"].map((path) => `https://club.example${path}`);

it("lists the public pages and public coach profiles on the configured origin", async () => {
  vi.stubEnv("APP_URL", "https://club.example");
  readPublicCoaching.mockResolvedValue({ programs: [], coaches: [{ id: "c1" }, { id: "c2" }] });
  expect((await sitemap()).map((entry) => entry.url)).toEqual([
    ...publicPages, "https://club.example/coaching/coaches/c1", "https://club.example/coaching/coaches/c2",
  ]);
  // A failed coaching read still lists the public pages.
  readPublicCoaching.mockRejectedValue(new Error("db"));
  expect((await sitemap()).map((entry) => entry.url)).toEqual(publicPages);
});

it("keeps private surfaces out of crawlers without blocking public pages", () => {
  vi.stubEnv("APP_URL", "https://club.example");
  const result = robots();
  expect(result.sitemap).toBe("https://club.example/sitemap.xml");
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  const disallow = [rules.disallow].flat();
  for (const path of ["/admin", "/coach/", "/account", "/profile", "/my-activity", "/reservations", "/login", "/api"]) expect(disallow).toContain(path);
  // "/coach" alone would also block /coaching.
  expect(disallow).not.toContain("/coach");
  for (const path of ["/courts", "/coaching", "/pricing", "/club", "/contact"]) {
    expect(disallow.some((rule) => !rule!.endsWith("$") && path.startsWith(rule!))).toBe(false);
  }

  vi.stubEnv("APP_URL", "");
  expect(robots().sitemap).toBeUndefined();
});
