import { beforeEach, expect, it, vi } from "vitest";
const { saveAdminPricingRule, removeAdminPricingRule, revalidatePath } = vi.hoisted(() => ({ saveAdminPricingRule: vi.fn(), removeAdminPricingRule: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/admin/pricing", () => ({ saveAdminPricingRule, removeAdminPricingRule }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { savePricingRuleAction, removePricingRuleAction } from "../../../src/app/admin/pricing/actions";
beforeEach(() => vi.resetAllMocks());
it.each([[savePricingRuleAction, saveAdminPricingRule], [removePricingRuleAction, removeAdminPricingRule]])("delegates and refreshes only pricing on success", async (action, mutate) => {
  const input = { location_id: "location" }; mutate.mockResolvedValue({ ok: true, id: "rule" });
  expect(await action(input)).toEqual({ ok: true, id: "rule" }); expect(mutate).toHaveBeenCalledExactlyOnceWith(input);
  expect(revalidatePath.mock.calls).toEqual([["/admin/pricing"]]); revalidatePath.mockClear();
  for (const reason of ["invalid-input", "overlap", "not-found"]) {
    mutate.mockResolvedValue({ ok: false, reason }); await action(input); expect(revalidatePath).not.toHaveBeenCalled();
  }
  mutate.mockRejectedValue(new Error("denied")); await expect(action(input)).rejects.toThrow("denied");
});
