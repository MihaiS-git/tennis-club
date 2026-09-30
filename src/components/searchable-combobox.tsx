"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

export type ComboboxOption = { value: string; label: string; searchText?: string };

export function SearchableCombobox({ id, name, options, value, defaultValue = "", onValueChange, disabled,
  placeholder, listLabel, emptyMessage, required, "aria-invalid": invalid, "aria-describedby": describedBy }: {
  id: string;
  name?: string;
  options: readonly ComboboxOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  placeholder: string;
  listLabel: string;
  emptyMessage: string;
  required?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoringFocus = useRef(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [openUp, setOpenUp] = useState(false);
  const [panelHeight, setPanelHeight] = useState(224);
  const selected = value ?? internalValue;
  const selectedOption = options.find((option) => option.value === selected);
  const matches = options.filter((option) => (option.searchText ?? option.label).toLocaleLowerCase().includes(search.toLocaleLowerCase()));

  useEffect(() => {
    if (!open) return;
    const handle = (event: globalThis.PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("pointerdown", handle);
    return () => document.removeEventListener("pointerdown", handle);
  }, [open]);

  useEffect(() => {
    if (open && matches[active]) {
      const list = listRef.current;
      const option = list?.children.item(active);
      if (list && option instanceof HTMLElement) {
        if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
          list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
        }
      }
    }
  }, [open, active, search, matches]);

  function showOptions() {
    if (disabled || open) return;
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) {
      const below = window.innerHeight - rect.bottom - 8;
      const above = rect.top - 8;
      const upwards = below < 224 && above > below;
      setOpenUp(upwards);
      setPanelHeight(Math.max(80, Math.min(224, upwards ? above : below)));
    }
    setSearch("");
    setActive(Math.max(0, options.findIndex((option) => option.value === selected)));
    setOpen(true);
  }

  function closeOptions() {
    setOpen(false);
    setSearch("");
  }

  function choose(option: ComboboxOption) {
    if (value === undefined) setInternalValue(option.value);
    onValueChange?.(option.value);
    closeOptions();
    if (document.activeElement !== inputRef.current) {
      restoringFocus.current = true;
      inputRef.current?.focus();
    }
  }

  function move(direction: number) {
    if (!open) {
      showOptions();
      return;
    }
    if (matches.length === 0) return;
    const next = (active + direction + matches.length) % matches.length;
    setActive(next);
  }

  // Keep focus on the input while an option is clicked.
  function keepInputFocus(event: PointerEvent<HTMLButtonElement>) {
    if (event.pointerType === "mouse") event.preventDefault();
  }

  return <div ref={rootRef} className="relative min-w-0">
    {name && <input type="hidden" name={name} value={selected} />}
    <input ref={inputRef} id={id} role="combobox" type="text" autoComplete="off"
      aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined}
      aria-activedescendant={open && matches[active] ? `${listId}-option-${active}` : undefined}
      aria-invalid={invalid} aria-describedby={describedBy} aria-required={required}
      disabled={disabled} placeholder={placeholder}
      className="min-h-10 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20 disabled:opacity-60"
      value={open ? search : selectedOption?.label ?? ""}
      onFocus={() => {
        if (restoringFocus.current) restoringFocus.current = false;
        else showOptions();
      }} onClick={showOptions}
      onChange={(event) => { setSearch(event.currentTarget.value); setActive(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter" && open) {
          event.preventDefault();
          if (matches[active]) choose(matches[active]);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); closeOptions();
        } else if (event.key === "Tab" && open) {
          closeOptions();
        }
      }} />
    {open && <div ref={listRef} id={listId} role="listbox" aria-label={listLabel}
      style={{ maxHeight: panelHeight }}
      className={`absolute z-40 w-full overflow-y-auto overscroll-contain rounded-control border border-border bg-surface shadow-floating ${openUp ? "bottom-full mb-1" : "mt-1"}`}>
      {matches.map((option, index) => <button key={option.value} id={`${listId}-option-${index}`}
        type="button" role="option" tabIndex={-1} aria-selected={option.value === selected}
        onPointerDown={keepInputFocus} onClick={() => choose(option)}
        className={`block min-h-9 w-full px-3 py-2 text-left text-sm hover:bg-surface-muted ${index === active ? "bg-surface-muted" : ""} ${option.value === selected ? "font-semibold text-primary" : "text-foreground"}`}>
        {option.label}
      </button>)}
      {matches.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">{emptyMessage}</p>}
    </div>}
  </div>;
}
