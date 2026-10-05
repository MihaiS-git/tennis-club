"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { localMinute, localToday } from "@/lib/courts/local-time";
import { minuteToTime } from "@/lib/admin/opening-hours-validation";

// One geometry for public prices and operational intervals. The header lives
// outside the horizontal scrollport so it sticks to the page, not a vertical scroller.
export function CourtTimelineGrid<T extends { court: { id: string; name: string } }>({
  times, rows, date, timezone, selectedStartMinute, selectedEndMinute, firstActionableMinute, renderCourtContext, renderCells,
}: {
  times: number[]; rows: T[]; date: string; timezone?: string;
  selectedStartMinute?: number; selectedEndMinute?: number; firstActionableMinute?: number;
  renderCourtContext?: (row: T) => ReactNode; renderCells: (row: T) => ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const initialized = useRef<string | null>(null);
  const loadKey = `${date}:${timezone}:${rows.map((row) => row.court.id).join(",")}`;
  const sizing: CSSProperties & { "--timeline-slot-count": number } = { "--timeline-slot-count": times.length };
  const columns: CSSProperties = { gridTemplateColumns: `var(--court-column) repeat(${times.length}, minmax(var(--timeline-slot-min), 1fr))`, minWidth: `calc(var(--court-column) + ${times.length} * var(--timeline-slot-min))` };

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || initialized.current === loadKey) return;
    initialized.current = loadKey;
    const now = new Date();
    const current = timezone && date === localToday(timezone, now) ? localMinute(timezone, now) : undefined;
    const minute = selectedStartMinute ?? (current === undefined ? firstActionableMinute : Math.max(current, firstActionableMinute ?? current)) ?? times[0];
    const matchingIndex = times.findIndex((time) => time + 30 > minute);
    const index = matchingIndex < 0 ? times.length - 1 : matchingIndex;
    const row = viewport.querySelector<HTMLElement>('[role="row"]');
    const courtWidth = row?.firstElementChild?.getBoundingClientRect().width ?? 112;
    const slotWidth = row ? (row.getBoundingClientRect().width - courtWidth) / times.length : 0;
    let left = Math.max(0, index - 2) * slotWidth;
    if (selectedEndMinute !== undefined) {
      const endIndex = times.filter((time) => time < selectedEndMinute).length;
      const visibleWidth = viewport.clientWidth - courtWidth;
      left = Math.min(index * slotWidth, Math.max(left, endIndex * slotWidth - visibleWidth));
    }
    viewport.scrollLeft = left;
    if (headerRef.current) headerRef.current.scrollLeft = viewport.scrollLeft;
  }, [loadKey, timezone, date, times, firstActionableMinute, selectedStartMinute, selectedEndMinute]);

  useEffect(() => {
    const navbars = [...document.querySelectorAll<HTMLElement>("header")].filter((element) => getComputedStyle(element).position === "sticky");
    const update = () => rootRef.current?.style.setProperty("--timeline-top", `${Math.max(0, ...navbars.map((element) => element.getBoundingClientRect().height))}px`);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    navbars.forEach((navbar) => observer.observe(navbar));
    return () => observer.disconnect();
  }, []);

  return <div ref={rootRef} role="table" aria-label="Court timetable" style={sizing} className="mt-3 min-w-0 max-w-full rounded-card border border-border bg-surface text-xs leading-none [container-type:inline-size] [--court-column:72px] sm:[--court-column:112px] [--timeline-slot-min:48px] [--timeline-cell-font-size:12px] lg:[--timeline-slot-min:0px] lg:[--timeline-cell-font-size:clamp(8px,calc((100cqw_-_var(--court-column))/var(--timeline-slot-count)*0.35),12px)]">
    <div className="sticky top-[var(--timeline-top,0px)] z-20 rounded-t-card bg-surface">
      <div ref={headerRef} role="rowgroup" className="overflow-hidden rounded-t-card">
        <div role="row" className="grid h-10" style={columns}>
          <div role="columnheader" className="sticky left-0 z-10 flex items-center border-b border-r border-border bg-surface px-2 font-semibold text-primary shadow-[2px_0_4px_var(--shadow-neutral)]">Court</div>
          {times.map((minute, index) => {
            if (minute % 60 !== 0 && index !== 0) return null;
            const span = minute % 60 === 0 && times[index + 1] === minute + 30 ? 2 : 1;
            return <div key={minute} role="columnheader" aria-colspan={span} aria-label={minuteToTime(minute)} style={{ gridColumn: `${index + 2} / span ${span}` }}
              className="flex items-center border-b border-r border-border bg-surface px-2 font-semibold tabular-nums text-primary">{minuteToTime(minute).slice(0, 2)}{minute % 60 !== 0 ? ":30" : ""}</div>;
          })}
        </div>
      </div>
    </div>
    <div ref={viewportRef} role="rowgroup" tabIndex={0} aria-label="Scroll court times" className="overflow-x-auto rounded-b-card focus-visible:outline-2 focus-visible:outline-focus [scroll-padding-left:var(--court-column)] [&_button]:scroll-mt-[calc(var(--timeline-top,0px)+44px)]"
      onScroll={(event) => { if (headerRef.current) headerRef.current.scrollLeft = event.currentTarget.scrollLeft; }}
      onFocusCapture={(event) => {
        const viewport = viewportRef.current;
        if (!viewport || !(event.target instanceof HTMLButtonElement)) return;
        const bounds = viewport.getBoundingClientRect();
        const focused = event.target.getBoundingClientRect();
        const courtWidth = viewport.querySelector('[role="rowheader"]')?.getBoundingClientRect().width ?? 112;
        if (focused.left < bounds.left + courtWidth) viewport.scrollLeft -= bounds.left + courtWidth - focused.left;
        else if (focused.right > bounds.right) viewport.scrollLeft += focused.right - bounds.right;
      }}>
      {rows.map((row) => <div key={row.court.id} role="row" className="grid h-11" style={columns}>
        <div role="rowheader" className="sticky left-0 z-10 flex min-w-0 flex-col justify-center border-b border-r border-border bg-surface px-2 text-primary shadow-[2px_0_4px_var(--shadow-neutral)]">
          <span className="truncate font-heading text-sm font-semibold" title={row.court.name}>{row.court.name}</span>
          {renderCourtContext && <span className="mt-1 truncate text-[10px] text-muted-foreground">{renderCourtContext(row)}</span>}
        </div>
        {renderCells(row)}
      </div>)}
    </div>
  </div>;
}
