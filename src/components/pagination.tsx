import { PendingLink } from "@/components/navigation-pending";
import { ChevronLeft, ChevronRight } from "lucide-react";

type PageItem = number | "ellipsis-start" | "ellipsis-end";

export function paginationItems(currentPage: number, totalPages: number): PageItem[] {
  if (totalPages <= 5) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const start = currentPage <= 2 ? 1 : currentPage >= totalPages - 1 ? totalPages - 2 : currentPage - 1;
  const pages = [...new Set([1, start, start + 1, start + 2, totalPages])];
  const items: PageItem[] = [];
  for (const page of pages) {
    const previous = items.at(-1);
    if (typeof previous === "number") {
      if (page - previous > 1) items.push(page === totalPages ? "ellipsis-end" : "ellipsis-start");
    }
    items.push(page);
  }
  return items;
}

type PaginationProps = {
  currentPage: number;
  buildHref(page: number): string;
  ariaLabel?: string;
  scroll?: boolean;
} & (
  | { totalPages: number; hasNext?: never }
  | { totalPages?: never; hasNext: boolean }
);

const control = "inline-flex h-8 min-w-8 shrink-0 items-center justify-center rounded-control border px-1 text-sm transition";
const inactive = "border-border bg-surface font-medium text-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";
const disabled = "border-border bg-surface-muted text-muted-foreground opacity-50";

export function Pagination({ currentPage, totalPages, hasNext, buildHref, ariaLabel = "Pagination", scroll = false }: PaginationProps) {
  if (totalPages !== undefined ? totalPages <= 1 : currentPage === 1 && !hasNext) return null;
  const items = totalPages === undefined ? [currentPage] : paginationItems(currentPage, totalPages);
  const canGoNext = totalPages === undefined ? hasNext : currentPage < totalPages;

  const previous = <><ChevronLeft aria-hidden="true" size={16} /><span className="sr-only sm:not-sr-only">Previous</span></>;
  const next = <><span className="sr-only sm:not-sr-only">Next</span><ChevronRight aria-hidden="true" size={16} /></>;
  const navigationControl = `${control} gap-1 sm:px-3`;

  return (
    <nav aria-label={ariaLabel} className="flex justify-center">
      <ul className="flex max-w-full flex-wrap items-center justify-center gap-0.5 sm:gap-1.5">
        <li>
          {currentPage > 1 ? (
            <PendingLink href={buildHref(currentPage - 1)} scroll={scroll} aria-label="Previous" className={`${navigationControl} ${inactive}`}>{previous}</PendingLink>
          ) : (
            <span aria-disabled="true" aria-label="Previous" className={`${navigationControl} ${disabled}`}>{previous}</span>
          )}
        </li>
        {items.map((item) => (
          <li key={item}>
            {typeof item !== "number" ? (
              <span className="inline-flex h-8 w-3 items-center justify-center text-muted-foreground" aria-label="More pages">…</span>
            ) : item === currentPage ? (
              <span aria-current="page" aria-label={`Page ${item}`} className={`${control} border-primary bg-primary font-semibold text-primary-foreground`}>{item}</span>
            ) : (
              <PendingLink href={buildHref(item)} scroll={scroll} className={`${control} ${inactive}`}>{item}</PendingLink>
            )}
          </li>
        ))}
        <li>
          {canGoNext ? (
            <PendingLink href={buildHref(currentPage + 1)} scroll={scroll} aria-label="Next" className={`${navigationControl} ${inactive}`}>{next}</PendingLink>
          ) : (
            <span aria-disabled="true" aria-label="Next" className={`${navigationControl} ${disabled}`}>{next}</span>
          )}
        </li>
      </ul>
    </nav>
  );
}
