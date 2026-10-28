import { z } from "zod";

export { formatMoney, type LocationCurrency } from "./currency";

export const minorAmountSchema = z.number().int().min(1).max(2147483647);

// Parse decimal digits directly: no floating-point multiplication or rounding.
export const majorAmountSchema = z.string().trim()
  .regex(/^\d{1,8}(?:\.\d{1,2})?$/, "Enter a positive amount with at most two decimal places.")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }).pipe(minorAmountSchema);

export function minorToMajor(amount: number): string {
  minorAmountSchema.parse(amount);
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`;
}
