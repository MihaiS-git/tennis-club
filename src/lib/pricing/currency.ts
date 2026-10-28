// Zod-free so client components can format prices without loading the
// validation library; schemas build on these values in their own modules.
export const locationCurrencies = ["EUR", "USD", "GBP", "RON", "CHF"] as const;
export type LocationCurrency = typeof locationCurrencies[number];

// Financial summaries and differences may legitimately be zero. Creation and
// pricing inputs still use the strictly positive minorAmountSchema.
export function formatMoney(amount: number, currency: LocationCurrency): string {
  if (!Number.isInteger(amount) || amount < 0 || amount > 2147483647) throw new RangeError(`Invalid minor amount: ${amount}`);
  if (!locationCurrencies.includes(currency)) throw new RangeError(`Unsupported currency: ${String(currency)}`);
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100);
}
