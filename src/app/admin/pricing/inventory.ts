import { z } from "zod";
import { courtStates, courtStateLabels, type PricingRuleSet } from "@/lib/pricing/validation";

export const pricingSortColumns = [
  { key: "courts", label: "Courts" },
  { key: "state", label: "State" },
  { key: "days", label: "Days" },
  { key: "time", label: "Time" },
  { key: "validity", label: "Validity" },
  { key: "price", label: "Price/hour" },
] as const;

export const pricingInventorySchema = z.object({
  pricingCourt: z.uuid().optional().catch(undefined),
  pricingState: z.enum(courtStates).optional().catch(undefined),
  pricingDay: z.enum(["0", "1", "2", "3", "4", "5", "6"]).optional().catch(undefined),
  pricingDate: z.iso.date().optional().catch(undefined),
  pricingSort: z.enum(["courts", "state", "days", "time", "validity", "price"]).default("courts").catch("courts"),
  pricingDir: z.enum(["asc", "desc"]).default("asc").catch("asc"),
});
export type PricingInventoryOptions = z.output<typeof pricingInventorySchema>;
export const pricingFilterKeys = ["pricingCourt", "pricingState", "pricingDay", "pricingDate"] as const;
const names = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function compareLists<T>(left: readonly T[], right: readonly T[], compare: (a: T, b: T) => number) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const result = compare(left[index], right[index]);
    if (result) return result;
  }
  return left.length - right.length;
}

export function selectPricingRules(rules: readonly PricingRuleSet[], courts: readonly { id: string; name: string }[], options: PricingInventoryOptions) {
  const rows = rules.map((item, index) => ({
    item, index,
    names: courts.filter((court) => item.court_ids.includes(court.id)).map((court) => court.name).sort(names.compare),
    days: [...item.weekdays].sort((a, b) => a - b),
  })).filter(({ item }) => (!options.pricingCourt || item.court_ids.includes(options.pricingCourt))
    && (!options.pricingState || item.court_state === options.pricingState)
    && (options.pricingDay === undefined || item.weekdays.includes(Number(options.pricingDay)))
    && (!options.pricingDate || ((!item.starts_on || item.starts_on <= options.pricingDate)
      && (!item.ends_on || item.ends_on >= options.pricingDate))));
  const compareCourts = (a: typeof rows[number], b: typeof rows[number]) => compareLists(a.names, b.names, names.compare);
  const compareDays = (a: typeof rows[number], b: typeof rows[number]) => compareLists(a.days, b.days, (x, y) => x - y);
  return rows.sort((a, b) => {
    const left = a.item, right = b.item;
    const state = () => courtStateLabels[left.court_state].localeCompare(courtStateLabels[right.court_state]);
    const primary = options.pricingSort === "courts" ? compareCourts(a, b) || state()
        || left.starts_at_minute - right.starts_at_minute || compareDays(a, b)
      : options.pricingSort === "state" ? state()
      : options.pricingSort === "days" ? compareDays(a, b)
      : options.pricingSort === "time" ? left.starts_at_minute - right.starts_at_minute || left.ends_at_minute - right.ends_at_minute
      : options.pricingSort === "validity" ? (left.starts_on ?? "").localeCompare(right.starts_on ?? "")
        || (left.ends_on ?? "9999-12-31").localeCompare(right.ends_on ?? "9999-12-31")
      : left.price_per_hour_minor - right.price_per_hour_minor;
    return (options.pricingDir === "asc" ? primary : -primary) || a.index - b.index;
  }).map(({ item, names }) => ({ item, courtNames: names.join(", ") }));
}
