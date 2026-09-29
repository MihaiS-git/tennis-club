import { beforeEach, expect, it, vi } from "vitest";

const { saveAdminLocation, revalidatePath } = vi.hoisted(() => ({ saveAdminLocation: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/locations", () => ({ saveAdminLocation }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { saveLocationAction } from "../../../src/app/admin/locations/actions";

beforeEach(() => vi.clearAllMocks());
it("delegates to the authorized domain mutation and refreshes admin and public reads on success", async () => {
  const input = { fields: { name: "Central" } };
  const result = { ok: true, id: "location" };
  saveAdminLocation.mockResolvedValue(result);
  expect(await saveLocationAction(input)).toBe(result);
  expect(saveAdminLocation).toHaveBeenCalledExactlyOnceWith(input);
  expect(revalidatePath.mock.calls).toEqual([["/admin/locations"], ["/courts"]]);
});
it.each(["invalid-input", "duplicate-slug", "not-found"])("does not revalidate on %s", async (reason) => {
  const result = { ok: false, reason };
  saveAdminLocation.mockResolvedValue(result);
  expect(await saveLocationAction({})).toBe(result);
  expect(revalidatePath).not.toHaveBeenCalled();
});
it("propagates authorization control flow without revalidation", async () => {
  saveAdminLocation.mockRejectedValue(new Error("notFound"));
  await expect(saveLocationAction({})).rejects.toThrow("notFound");
  expect(revalidatePath).not.toHaveBeenCalled();
});
