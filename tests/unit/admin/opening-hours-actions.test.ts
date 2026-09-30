import { beforeEach, expect, it, vi } from "vitest";
const { mutateAdminOpeningHours, revalidatePath } = vi.hoisted(() => ({ mutateAdminOpeningHours: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/opening-hours", () => ({ mutateAdminOpeningHours }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { mutateOpeningHoursAction } from "../../../src/app/admin/locations/opening-hours-actions";
beforeEach(() => vi.resetAllMocks());

it("delegates one weekly operation and refreshes the location page only on success", async () => {
  const input = { location_id: "location", weekdays: [0, 1, 2, 3, 4], intervals: [], replace_ids: [] };
  mutateAdminOpeningHours.mockResolvedValueOnce({ ok: true, intervals: [] });
  expect(await mutateOpeningHoursAction(input)).toEqual({ ok: true, intervals: [] });
  expect(mutateAdminOpeningHours).toHaveBeenCalledExactlyOnceWith(input);
  expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/admin/locations");
  revalidatePath.mockClear();
  mutateAdminOpeningHours.mockResolvedValueOnce({ ok: false, reason: "overlap", weekdays: [1] });
  expect(await mutateOpeningHoursAction(input)).toEqual({ ok: false, reason: "overlap", weekdays: [1] });
  expect(revalidatePath).not.toHaveBeenCalled();
});
