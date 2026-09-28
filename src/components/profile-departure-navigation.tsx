"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useRef, type ComponentProps, type ReactNode, type RefObject } from "react";

type Departure = (proceed: () => void) => boolean;
const ProfileDepartureContext = createContext<RefObject<Departure | null> | null>(null);

// Only the active Profile visit registers a handler. No form values live here.
export function ProfileDepartureProvider({ children }: { children: ReactNode }) {
  const handler = useRef<Departure | null>(null);
  return <ProfileDepartureContext value={handler}>{children}</ProfileDepartureContext>;
}

export function useProfileDepartureRegistration() {
  return useContext(ProfileDepartureContext);
}

type ProfileLinkProps = Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { href: string };

export function ProfileDepartureLink({ href, replace, scroll, transitionTypes, ...props }: ProfileLinkProps) {
  const handler = useContext(ProfileDepartureContext);
  const router = useRouter();
  return <Link {...props} href={href} replace={replace} scroll={scroll} transitionTypes={transitionTypes}
    onNavigate={(event) => {
      if (new URL(href, window.location.href).pathname === "/profile") return;
      const proceed = () => {
        const options = { scroll, transitionTypes };
        if (replace) router.replace(href, options);
        else router.push(href, options);
      };
      if (handler?.current?.(proceed)) event.preventDefault();
    }} />;
}

// Guard the existing sign-out forms before their unchanged Server Action runs.
export function ProfileDepartureForm(props: ComponentProps<"form">) {
  const handler = useContext(ProfileDepartureContext);
  const approved = useRef(false);
  return <form {...props} onSubmit={(event) => {
    props.onSubmit?.(event);
    if (event.defaultPrevented) return;
    if (approved.current) {
      approved.current = false;
      return;
    }
    const form = event.currentTarget;
    const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
    if (handler?.current?.(() => {
      approved.current = true;
      form.requestSubmit(submitter);
    })) event.preventDefault();
  }} />;
}
