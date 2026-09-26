const userDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatUserDate(value: string) {
  return userDateFormatter.format(new Date(value)).replace("Sept", "Sep");
}
