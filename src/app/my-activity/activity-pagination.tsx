import Link from "next/link";
import { Pagination } from "@/components/pagination";
import { activityHref, type ActivityQuery, type ActivityScope } from "@/lib/bookings/activity-query";

// Activity reads only know whether a next page exists.
export function ActivityPagination({ scope, query, hasNext, empty }: {
  scope: ActivityScope; query: ActivityQuery; hasNext: boolean; empty: boolean;
}) {
  return <>
    {(query.page > 1 || hasNext) && <div className="mt-5">
      <Pagination currentPage={query.page} hasNext={hasNext} ariaLabel="Activity pages" scroll
        buildHref={(page) => activityHref(scope, query, page)} />
    </div>}
    {query.page > 1 && empty && <p className="mt-4 text-center"><Link href={activityHref(scope, query, 1)} className="text-sm font-semibold text-primary underline underline-offset-4">Return to first page</Link></p>}
  </>;
}
