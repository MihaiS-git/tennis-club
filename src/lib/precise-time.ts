// Interpret the instant with Date.parse, then restore its sub-millisecond
// remainder. Preserve PostgreSQL microseconds without rounding fractional digits.
export function timestampToEpochMicroseconds(value: string): bigint {
  const fraction = value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}
