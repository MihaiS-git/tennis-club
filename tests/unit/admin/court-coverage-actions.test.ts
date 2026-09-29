import { beforeEach, expect, it, vi } from "vitest";
const { saveAdminCourtCoverage, removeAdminCourtCoverage, revalidatePath } = vi.hoisted(() => ({ saveAdminCourtCoverage: vi.fn(), removeAdminCourtCoverage: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/court-coverage", () => ({ saveAdminCourtCoverage, removeAdminCourtCoverage }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { saveCoverageAction, removeCoverageAction } from "../../../src/app/admin/courts/actions";
beforeEach(() => vi.clearAllMocks());
it.each([[saveCoverageAction, saveAdminCourtCoverage], [removeCoverageAction, removeAdminCourtCoverage]])("delegates and revalidates only admin coverage", async (action, operation) => {
  operation.mockResolvedValue({ ok: true, id: "period" });
  expect(await action({})).toEqual({ ok: true, id: "period" });
  expect(operation).toHaveBeenCalledExactlyOnceWith({}); expect(revalidatePath.mock.calls).toEqual([["/admin/courts"]]);
});
it.each([[saveCoverageAction, saveAdminCourtCoverage], [removeCoverageAction, removeAdminCourtCoverage]])("preserves errors and authorization", async (action, operation) => {
  operation.mockResolvedValue({ ok: false, reason: "overlap" }); await action({}); expect(revalidatePath).not.toHaveBeenCalled();
  operation.mockRejectedValue(new Error("denied")); await expect(action({})).rejects.toThrow("denied");
});
