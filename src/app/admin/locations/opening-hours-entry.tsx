"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import type { OpeningInterval } from "@/lib/admin/opening-hours-validation";
import { OpeningHours } from "./opening-hours";

export function OpeningHoursEntry({
  locationId,
  locationName,
  intervals,
}: {
  locationId: string;
  locationName: string;
  intervals: OpeningInterval[];
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hoursState, setHoursState] = useState({
    source: intervals,
    current: intervals,
  });
  const currentIntervals =
    hoursState.source === intervals ? hoursState.current : intervals;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        onClick={() => setOpen(true)}
      >
        Manage opening hours
      </button>
      {open &&
        createPortal(
          <ModalDialog
            ref={dialogRef}
            active={open}
            aria-labelledby={`${id}-title`}
            onClick={(event) => event.stopPropagation()}
            onClose={() => {
              setOpen(false);
              buttonRef.current?.focus();
            }}
            className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-2xl rounded-card border border-border bg-surface p-5 text-foreground shadow-floating backdrop:bg-foreground/50"
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <h2
                id={`${id}-title`}
                className="font-heading text-xl font-semibold"
              >
                {locationName} opening hours
              </h2>
              <button
                type="button"
                className="rounded-control text-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                onClick={() => dialogRef.current?.close()}
              >
                Close
              </button>
            </div>
            <OpeningHours
              locationId={locationId}
              intervals={currentIntervals}
              onUpdated={(next) =>
                setHoursState({ source: intervals, current: next })
              }
            />
          </ModalDialog>,
          document.body,
        )}
    </>
  );
}
