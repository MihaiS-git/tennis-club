// Presentation grouping of server-resolved slot rates. No pricing is resolved here.
export type PriceBand = { startIndex: number; endIndex: number; rate: number; labels: number[] };

// Consecutive equal rates form one band; a change at any half-hour splits it.
// Long bands repeat their label every `repeatEvery` slots so a scrolled
// timetable always shows a visible rate.
export function priceBands(rates: readonly (number | null)[], repeatEvery = 4): PriceBand[] {
  const bands: PriceBand[] = [];
  rates.forEach((rate, index) => {
    const last = bands.at(-1);
    if (rate === null) return;
    if (last && last.rate === rate && last.endIndex === index) last.endIndex = index + 1;
    else bands.push({ startIndex: index, endIndex: index + 1, rate, labels: [] });
  });
  for (const band of bands)
    for (let index = band.startIndex; index < band.endIndex; index += repeatEvery) band.labels.push(index);
  return bands;
}

export function formatHourlyRate(rateMinor: number, currency: string) {
  const amount = rateMinor / 100;
  return `${currency} ${Number.isInteger(amount) ? amount : amount.toFixed(2)}/h`;
}
