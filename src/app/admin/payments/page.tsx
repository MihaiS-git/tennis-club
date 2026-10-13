import { redirect } from "next/navigation";

export const instant = false;

export default async function LegacyPaymentsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  redirect(`/admin/payments/transactions${query.size ? `?${query}` : ""}`);
}
