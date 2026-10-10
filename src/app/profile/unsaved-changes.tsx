"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useProfileDepartureRegistration } from "@/components/profile-departure-navigation";
import styles from "./unsaved-changes.module.css";

type FormName = string;
const profileLabels: Readonly<Record<string, string>> = { personal: "Personal information", tennis: "Tennis profile" };
const DirtyFormsContext = createContext<((form: FormName, dirty: boolean) => void) | null>(null);
const DirtySectionsContext = createContext<readonly FormName[]>([]);
type Confirmation = { id: string | number; proceed: () => void };

export function ProfileUnsavedChanges({ children, onDeparture, sectionLabels = profileLabels, captureLinksFrom }: {
  children: ReactNode; onDeparture: () => void;
  sectionLabels?: Readonly<Record<string, string>>;
  captureLinksFrom?: string;
}) {
  const router = useRouter();
  const registrationRef = useProfileDepartureRegistration();
  const dirtyForms = useRef(new Set<FormName>());
  const [dirtySections, setDirtySections] = useState<readonly FormName[]>([]);
  const dirty = dirtySections.length > 0;
  const confirmation = useRef<Confirmation | null>(null);
  const dismissConfirmation = useCallback(() => {
    const current = confirmation.current;
    confirmation.current = null;
    if (current) toast.dismiss(current.id);
  }, []);
  const report = useCallback((form: FormName, isDirty: boolean) => {
    if (isDirty) dirtyForms.current.add(form);
    else dirtyForms.current.delete(form);
    setDirtySections([...dirtyForms.current]);
  }, []);

  useLayoutEffect(() => {
    if (!registrationRef) return;
    const handler = (proceed: () => void) => {
      if (dirtyForms.current.size === 0) {
        onDeparture();
        return false;
      }
      if (confirmation.current) {
        confirmation.current.proceed = proceed;
        return true;
      }
      const session: Confirmation = { id: 0, proceed };
      confirmation.current = session;
      const sections = [...new Set([...dirtyForms.current].map((form) =>
        sectionLabels[form] ?? Object.keys(sectionLabels).find((label) => form.startsWith(`${label} `)) ?? form))];
      const message = sections.length === 1
        ? `You have unsaved changes in ${sections[0]}.`
        : `You have unsaved changes in ${sections.length} sections.`;
      session.id = toast.warning(message, {
        className: styles.confirmation,
        closeButton: false,
        icon: null,
        duration: Infinity,
        onDismiss: () => {
          if (confirmation.current === session) confirmation.current = null;
        },
        cancel: { label: "Stay", onClick: () => {
          if (confirmation.current === session) dismissConfirmation();
        } },
        action: { label: "Leave without saving", onClick: () => {
          if (confirmation.current !== session) return;
          dismissConfirmation();
          onDeparture();
          session.proceed();
        } },
      });
      return true;
    };
    registrationRef.current = handler;
    return () => {
      if (registrationRef.current === handler) registrationRef.current = null;
      dismissConfirmation();
    };
  }, [registrationRef, onDeparture, dismissConfirmation, sectionLabels]);

  useLayoutEffect(() => {
    if (!dirty) {
      dismissConfirmation();
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty, dismissConfirmation]);

  // Admin links use ordinary Next Links. Route them through the same registered
  // departure handler; changes within a retained workspace do not discard drafts.
  useLayoutEffect(() => {
    if (!captureLinksFrom || !registrationRef) return;
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.download || (anchor.target && anchor.target !== "_self")) return;
      const target = new URL(anchor.href);
      if (target.origin === window.location.origin && target.pathname === captureLinksFrom) return;
      const proceed = () => {
        if (target.origin === window.location.origin) router.push(`${target.pathname}${target.search}${target.hash}`);
        else window.location.assign(target.href);
      };
      if (registrationRef.current?.(proceed)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [captureLinksFrom, registrationRef, router]);

  return <DirtyFormsContext value={report}>
    <DirtySectionsContext value={dirtySections}>{children}</DirtySectionsContext>
  </DirtyFormsContext>;
}

export function useDirtyProfileSections() {
  return useContext(DirtySectionsContext);
}

export function useProfileFormDirty(form: FormName, dirty: boolean) {
  const report = useContext(DirtyFormsContext);
  useLayoutEffect(() => {
    report?.(form, dirty);
    return () => report?.(form, false);
  }, [report, form, dirty]);
}
