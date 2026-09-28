"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useProfileDepartureRegistration } from "@/components/profile-departure-navigation";
import styles from "./unsaved-changes.module.css";

type FormName = "personal" | "tennis";
const DirtyFormsContext = createContext<((form: FormName, dirty: boolean) => void) | null>(null);
const DirtySectionsContext = createContext<readonly FormName[]>([]);
type Confirmation = { id: string | number; proceed: () => void };

export function ProfileUnsavedChanges({ children, onDeparture }: { children: ReactNode; onDeparture: () => void }) {
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
      const section = dirtyForms.current.has("personal") ? "Personal information" : "Tennis profile";
      const message = dirtyForms.current.size === 1
        ? `You have unsaved changes in ${section}.`
        : "You have unsaved changes in 2 sections.";
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
  }, [registrationRef, onDeparture, dismissConfirmation]);

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
