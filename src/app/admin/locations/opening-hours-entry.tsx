"use client";

import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ModalDialog } from "@/components/modal-dialog";
import { Button, DialogCloseButton } from "@/components/button";
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
      <Button
        ref={buttonRef}
        type="button"
        variant="subtle" size="small"
        onClick={() => setOpen(true)}
      >
        Manage opening hours
      </Button>
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
            <header className="mb-4 flex items-center justify-between gap-4 border-b border-border pb-4">
              <h2
                id={`${id}-title`}
                className="font-heading text-xl font-semibold"
              >
                {locationName} opening hours
              </h2>
              <DialogCloseButton onClick={() => dialogRef.current?.close()} />
            </header>
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
