import Link from "next/link";
import { activityHref, type ActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";

export function ActivityPagination({ scope, query, hasNext, empty }: {
  scope: ActivityScope; query: ActivityQuery; hasNext: boolean; empty: boolean;
}) {
  return <>
    {(query.page > 1 || hasNext) && <nav aria-label="Activity pages" className="mt-5 flex items-center justify-between text-sm">
      {query.page > 1 ? <Link href={activityHref(scope, query, query.page - 1)} className="font-semibold text-primary underline underline-offset-4">Previous</Link> : <span />}
      <span>Page {query.page} · 20 per page</span>
      {hasNext ? <Link href={activityHref(scope, query, query.page + 1)} className="font-semibold text-primary underline underline-offset-4">Next</Link> : <span />}
    </nav>}
    {query.page > 1 && empty && <Link href={activityHref(scope, query, 1)} className="mt-4 inline-block text-sm font-semibold text-primary underline underline-offset-4">Return to first page</Link>}
  </>;
}
