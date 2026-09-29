import { beforeEach, expect, it, vi } from "vitest";
const { saveAdminCourt, revalidatePath } = vi.hoisted(() => ({ saveAdminCourt: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/courts", () => ({ saveAdminCourt }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { saveCourtAction } from "../../../src/app/admin/courts/actions";
beforeEach(() => vi.clearAllMocks());
it("delegates to the authorized domain mutation and refreshes admin and public reads on success", async () => {
  const input = { fields: { name: "Court One" } };
  const result = { ok: true, id: "court" };
  saveAdminCourt.mockResolvedValue(result);
  expect(await saveCourtAction(input)).toBe(result);
  expect(saveAdminCourt).toHaveBeenCalledExactlyOnceWith(input);
  expect(revalidatePath.mock.calls).toEqual([["/admin/courts"], ["/courts"]]);
});
it.each(["invalid-input", "duplicate-slug", "not-found", "invalid-location"])("does not revalidate on %s", async (reason) => {
  const result = { ok: false, reason };
  saveAdminCourt.mockResolvedValue(result);
  expect(await saveCourtAction({})).toBe(result);
  expect(revalidatePath).not.toHaveBeenCalled();
});
it("preserves authorization control flow", async () => {
  saveAdminCourt.mockRejectedValue(new Error("notFound"));
  await expect(saveCourtAction({})).rejects.toThrow("notFound");
  expect(revalidatePath).not.toHaveBeenCalled();
});
