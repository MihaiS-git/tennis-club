import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const { loadLocations } = vi.hoisted(() => ({ loadLocations: vi.fn() }));
vi.mock("@/lib/courts/public", () => ({ listPublicLocationsWithCourts: loadLocations }));
import { CourtsDiscovery } from "@/app/courts/courts-discovery";

it("renders only locations returned by the shared public eligibility read", async () => {
  loadLocations.mockResolvedValue([{ id: "eligible", name: "RIVUS", address_line1: null, address_line2: null,
    city: null, postal_code: null, country_code: null,
    courts: [{ id: "court", name: "Court 1", surface: "clay", environment: "outdoor", has_lighting: false }] }]);
  const html = renderToStaticMarkup(await CourtsDiscovery());
  expect(html).toContain("RIVUS");
  expect(html).toContain("Court 1");
  expect(html).not.toContain("Central Club");
  expect(html).not.toContain("Riverside Club");
});
