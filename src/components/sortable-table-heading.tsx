import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

export type TableSortLink = { href: string; direction?: "asc" | "desc" };

export function tableAriaSort(sort?: TableSortLink) {
  return sort?.direction === "asc" ? "ascending" : sort?.direction === "desc" ? "descending" : "none";
}

// The active direction is shown by its arrow and announced through aria-sort on the heading.
export function SortableTableLink({ label, sort }: { label: string; sort: TableSortLink }) {
  const Icon = sort.direction === "asc" ? ArrowUp : sort.direction === "desc" ? ArrowDown : ArrowUpDown;
  return <Link href={sort.href} scroll={false} className={`inline-flex items-center gap-1.5 rounded-control hover:text-primary focus-visible:outline-2 focus-visible:outline-primary ${sort.direction ? "text-primary" : ""}`}>
    {label}<Icon aria-hidden size={14} />
  </Link>;
}

export function SortableTableHeading({ label, sort, className = "px-4 py-2.5" }: {
  label: string; sort?: TableSortLink; className?: string;
}) {
  return <th scope="col" className={className} aria-sort={tableAriaSort(sort)}>
    {sort ? <SortableTableLink label={label} sort={sort} /> : label}
  </th>;
}
