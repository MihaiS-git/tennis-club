"use client";

import { useState, type ReactNode } from "react";

export function ProfileSettings({ identity, personal, tennis, account }: {
  identity: ReactNode;
  personal: ReactNode;
  tennis: ReactNode;
  account: ReactNode;
}) {
  const [selected, setSelected] = useState("identity");
  const sections = [
    { id: "identity", title: "Profile / player identity", description: "", content: identity },
    { id: "personal", title: "Personal information", description: "Your contact and address details stay private.", content: personal },
    { id: "tennis", title: "Tennis profile", description: "Introduce yourself to the club. Tennis information is visible to active signed-in users.", content: tennis },
    { id: "account", title: "Account & security", description: "Your sign-in details, password and account access.", content: account },
  ];

  return (
    <div className="space-y-5 md:space-y-6">
      <nav aria-label="Profile settings" className="flex min-w-0 max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-card border border-border bg-surface p-1 sm:grid sm:grid-cols-4 sm:overflow-visible">
        {sections.map(({ id, title }) => (
          <button key={id} type="button" aria-pressed={selected === id} aria-controls={`${id}-settings`}
            onClick={() => setSelected(id)}
            className={`min-h-12 shrink-0 whitespace-nowrap rounded-control px-2 py-2 text-xs font-medium leading-5 transition sm:min-h-14 sm:whitespace-normal sm:text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${selected === id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-surface-muted hover:text-primary"}`}>
            {title}
          </button>
        ))}
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
