"use client";

import { useMemo } from "react";
import { SearchableCombobox, type ComboboxOption } from "@/components/searchable-combobox";
import { countries, countryFlag } from "@/lib/profile/countries";
import { locationCurrencies, locationFieldsSchema } from "@/lib/admin/locations-validation";
import { timezoneDisplayLabel } from "./timezone-display";

export const locationControlClass = "min-h-10 w-full rounded-control border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-focus/20";

type SelectProps = {
  id: string;
  name?: string;
  defaultValue?: string | number;
  value?: string | number;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  onChange?: React.ChangeEventHandler<HTMLSelectElement>;
};

type SearchProps = {
  id: string;
  name?: string;
  defaultValue?: string;
  value?: string;
  disabled?: boolean;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  onValueChange?: (value: string) => void;
};

const countryOptions: ComboboxOption[] = [
  { value: "", label: "Not specified" },
  ...countries.map(({ code, name }) => ({ value: code, label: `${countryFlag(code)} ${name}`, searchText: name })),
];
const currencyLabels: Record<typeof locationCurrencies[number], string> = {
  EUR: "🇪🇺 EUR — Euro",
  USD: "🇺🇸 USD — US Dollar",
  GBP: "🇬🇧 GBP — Pound sterling",
  RON: "🇷🇴 RON — Romanian leu",
  CHF: "🇨🇭 CHF — Swiss franc",
};

export function CountryCombobox(props: SearchProps) {
  return <SearchableCombobox {...props} options={countryOptions} placeholder="Select a country"
    listLabel="Countries" emptyMessage="No countries found." />;
}

export function CurrencySelect(props: SelectProps) {
  return <select {...props} className={locationControlClass}>
    {locationCurrencies.map((currency) => <option key={currency} value={currency}>{currencyLabels[currency]}</option>)}
  </select>;
}

export function StatusSelect(props: SelectProps) {
  return <select {...props} className={locationControlClass}>
    <option value="true">Active</option><option value="false">Inactive</option>
  </select>;
}

export function TimezoneCombobox(props: SearchProps) {
  const current = props.value ?? props.defaultValue ?? "";
  const options = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
    const zones = [...new Set(["UTC", ...supported,
      ...(current && locationFieldsSchema.shape.timezone.safeParse(current).success ? [current] : []),
    ])].sort();
    const now = new Date();
    return zones.map((zone) => ({ value: zone, label: timezoneDisplayLabel(zone, now) }));
  }, [current]);
  return <SearchableCombobox {...props} options={options}
    placeholder="Select a timezone" listLabel="Timezones" emptyMessage="No timezones found." required />;
}
