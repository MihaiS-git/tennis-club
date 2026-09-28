"use client";

import { useId, useState } from "react";
import { Input } from "@/components/input";
import { countries, countryFlag } from "@/lib/profile/countries";

export function CountrySelect({ value, onChange, error }: {
  value: string; onChange: (value: string) => void; error?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const selectedName = countries.find((country) => country.code === value)?.name ?? "";
  const selectedFlag = !open ? countryFlag(value) : "";
  const options = [
    ...(!search ? [{ code: "", name: "Not specified" }] : []),
    ...countries.filter((country) => country.name.toLowerCase().includes(search.toLowerCase())),
  ];
  function choose(code: string) {
    onChange(code);
    setOpen(false);
    setSearch("");
  }
  function highlight(index: number) {
    setActive(index);
    document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: "nearest" });
  }
  return <div className="relative min-w-0">
    <input type="hidden" name="country_code" value={value} />
    {selectedFlag && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center">{selectedFlag}</span>}
    <Input id="country_code" role="combobox" aria-autocomplete="list" aria-expanded={open}
      aria-controls={listId} aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
      aria-invalid={Boolean(error)} aria-describedby={error ? "country_code-error" : undefined}
      autoComplete="off" placeholder="Select a country" className={`min-h-11 min-w-0${selectedFlag ? " pl-11" : ""}`}
      value={open ? search : selectedName}
      onFocus={() => { setOpen(true); setSearch(""); setActive(0); }}
      onBlur={() => { setOpen(false); setSearch(""); }}
      onChange={(event) => { setSearch(event.target.value); setActive(0); setOpen(true); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpen(true);
          highlight(open ? Math.max(0, Math.min(options.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))) : 0);
        } else if (event.key === "Enter" && open) {
          event.preventDefault();
          if (options[active]) choose(options[active].code);
        } else if (event.key === "Escape" && open) {
          event.preventDefault(); setOpen(false); setSearch("");
        }
      }} />
    {open && <div id={listId} role="listbox" aria-label="Countries"
      className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-control border border-border bg-surface shadow-card">
      {options.map((country, index) => <button key={country.code} id={`${listId}-${index}`} type="button"
        role="option" tabIndex={-1} aria-selected={country.code === value}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(country.code)}
        className={`block min-h-11 w-full break-words px-3 py-2 text-left text-sm hover:bg-surface-muted ${index === active ? "bg-surface-muted" : ""}`}>
        {country.code && <span aria-hidden="true" className="mr-2">{countryFlag(country.code)}</span>}{country.name}
      </button>)}
      {options.length === 0 && <p role="status" className="px-3 py-3 text-sm text-muted-foreground">No countries found.</p>}
    </div>}
  </div>;
}
