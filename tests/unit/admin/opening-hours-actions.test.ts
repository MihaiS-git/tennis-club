import { beforeEach, expect, it, vi } from "vitest";
const { saveAdminOpeningHours, removeAdminOpeningHours, revalidatePath } = vi.hoisted(() => ({ saveAdminOpeningHours: vi.fn(), removeAdminOpeningHours: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/opening-hours", () => ({ saveAdminOpeningHours, removeAdminOpeningHours }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { saveOpeningHoursAction, removeOpeningHoursAction } from "../../../src/app/admin/locations/opening-hours-actions";
beforeEach(() => vi.resetAllMocks());
it.each([[saveOpeningHoursAction, saveAdminOpeningHours], [removeOpeningHoursAction, removeAdminOpeningHours]])("delegates and refreshes only the admin location page", async (action, mutate) => {
  const input = { location_id: "location" };
  mutate.mockResolvedValue({ ok: true, id: "interval" });
  expect(await action(input)).toEqual({ ok: true, id: "interval" });
  expect(mutate).toHaveBeenCalledExactlyOnceWith(input);
  expect(revalidatePath.mock.calls).toEqual([["/admin/locations"]]);
  revalidatePath.mockClear();
  for (const reason of ["invalid-input", "overlap", "not-found"]) {
    mutate.mockResolvedValue({ ok: false, reason });
    expect(await action(input)).toEqual({ ok: false, reason });
    expect(revalidatePath).not.toHaveBeenCalled();
  }
  mutate.mockRejectedValue(new Error("denied"));
  await expect(action(input)).rejects.toThrow("denied");
  expect(revalidatePath).not.toHaveBeenCalled();
});
