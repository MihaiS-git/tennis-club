import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ locations: vi.fn() }));
vi.mock("../../../src/lib/admin/locations", () => ({ listAdminLocationsWithReadiness: mocks.locations }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
import CourtsPage from "../../../src/app/admin/courts/page";
import PricingPage from "../../../src/app/admin/pricing/page";

const id = "a1000000-0000-4000-8000-000000000001";
beforeEach(() => { vi.clearAllMocks(); mocks.locations.mockResolvedValue([{ id }]); });

for (const [tab, page] of [["courts", CourtsPage], ["pricing", PricingPage]] as const) {
  it(`${tab} redirects an existing location and preserves filters, sort and repeated parameters`, async () => {
    await expect(page({ searchParams: Promise.resolve({ location: id, tab: "details", status: "inactive", sort: "name", dir: "desc", tag: ["one", "two"] }) }))
      .rejects.toThrow(`redirect:/admin/locations/${id}?status=inactive&sort=name&dir=desc&tag=one&tag=two&tab=${tab}`);
    expect(mocks.locations).toHaveBeenCalledWith("current", id);
  });

  it.each([undefined, "", "not-a-uuid", [id], [id, id]])(`${tab} redirects missing or ambiguous/invalid location %s to Locations`, async (location) => {
    await expect(page({ searchParams: Promise.resolve({ location }) })).rejects.toThrow("redirect:/admin/locations");
    expect(mocks.locations).not.toHaveBeenCalled();
  });

  it(`${tab} redirects a nonexistent location to Locations`, async () => {
    mocks.locations.mockResolvedValue([]);
    await expect(page({ searchParams: Promise.resolve({ location: id }) })).rejects.toThrow("redirect:/admin/locations");
  });

  it(`${tab} preserves bookmarked archived locations when the workspace read finds them`, async () => {
    mocks.locations.mockResolvedValue([{ id, archived_at: "2026-10-01T00:00:00Z" }]);
    await expect(page({ searchParams: Promise.resolve({ location: id }) })).rejects.toThrow(`redirect:/admin/locations/${id}?tab=${tab}`);
  });

  it(`${tab} redirects URLs without search parameters to Locations`, async () => {
    await expect(page({})).rejects.toThrow("redirect:/admin/locations");
  });
}
