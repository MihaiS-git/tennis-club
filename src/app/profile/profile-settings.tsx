"use client";

import { useCallback, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ProfileUnsavedChanges, useDirtyProfileSections } from "./unsaved-changes";

const subscribeToHydration = () => () => {};

export function ProfileSettings({ identity, personal, tennis, account }: {
  identity: ReactNode;
  personal: ReactNode;
  tennis: ReactNode;
  account: ReactNode;
}) {
  const { bfcacheId } = useRouter();
  const [visit, setVisit] = useState(0);
  const leaveVisit = useCallback(() => setVisit((current) => current + 1), []);
  useLayoutEffect(() => () => {
    // Activity hides this subtree on browser history and router departures.
    leaveVisit();
  }, [leaveVisit]);
  return <ProfileUnsavedChanges onDeparture={leaveVisit}>
    <ProfileSettingsContent key={`${bfcacheId}:${visit}`} identity={identity} personal={personal} tennis={tennis} account={account} />
  </ProfileUnsavedChanges>;
}

function ProfileSettingsContent({ identity, personal, tennis, account }: Parameters<typeof ProfileSettings>[0]) {
  // The server preview cannot switch sections until React attaches its handlers.
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [selected, setSelected] = useState("identity");
  const dirtySections = useDirtyProfileSections();
  const sections = [
    { id: "identity", title: "Profile / player identity", description: "", content: identity },
    { id: "personal", title: "Personal information", description: "Your contact and address details stay private.", content: personal },
    { id: "tennis", title: "Tennis profile", description: "Introduce yourself to the club. Tennis information is visible to active signed-in users.", content: tennis },
    { id: "account", title: "Account & security", description: "Your sign-in details, password and account access.", content: account },
  ];

  return (
    <div className="space-y-5 md:space-y-6">
      <nav aria-label="Profile settings" className="flex min-w-0 max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-card border border-border bg-surface p-1 sm:grid sm:grid-cols-4 sm:overflow-visible">
        {sections.map(({ id, title }) => {
          const isDirty = dirtySections.some((form) => form === id);
          return (
            <button key={id} type="button" aria-pressed={selected === id} aria-controls={`${id}-settings`}
              disabled={!hydrated}
              aria-label={isDirty ? `${title}, unsaved changes` : undefined}
              onClick={() => setSelected(id)}
              className={`min-h-12 shrink-0 whitespace-nowrap rounded-control px-2 py-2 text-xs font-medium leading-5 transition sm:min-h-14 sm:whitespace-normal sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-wait disabled:opacity-60 ${selected === id ? "bg-primary text-primary-foreground" : "text-muted-foreground enabled:hover:bg-surface-muted enabled:hover:text-primary"}`}>
              <span className="relative inline-block">
                {title}
                {isDirty && <span role="img" aria-label="Unsaved changes"
                  className={`absolute left-full top-1/2 ml-1 size-1.5 -translate-y-1/2 rounded-full ${selected === id ? "bg-primary-foreground" : "bg-accent"}`} />}
              </span>
            </button>
          );
        })}
      </nav>
      {sections.map(({ id, title, description, content }) => (
        <div key={id} id={`${id}-settings`} hidden={selected !== id}>
          {id === "identity" ? content : (
            <section aria-labelledby={`${id}-heading`}
              className="grid min-w-0 gap-6 rounded-card border border-border bg-surface-elevated p-5 md:grid-cols-[11rem_minmax(0,1fr)] md:p-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10 lg:p-8">
              <div>
                <h2 id={`${id}-heading`} className="font-heading text-xl font-semibold text-primary">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
              </div>
              <div className="min-w-0 w-full max-w-2xl [&_input]:text-base [&_select]:text-base [&_textarea]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm sm:[&_textarea]:text-sm">{content}</div>
            </section>
          )}
        </div>
      ))}
    </div>
  );
}
