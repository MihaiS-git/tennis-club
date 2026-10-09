"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import { resendConfirmationAction } from "@/app/(auth)/actions";
import { FormMessage } from "@/components/auth-form";
import { Button } from "@/components/button";
import { initialAuthActionState } from "@/lib/auth/action-state";
import { CONFIRMATION_RESEND_COOLDOWN_SECONDS } from "@/lib/auth/confirmation";

export function ResendConfirmation({ email, getEmail }: { email: string; getEmail?: never } | { email?: never; getEmail: () => string }) {
  const [state, action, pending] = useActionState(resendConfirmationAction, initialAuthActionState);
  const { pending: formPending } = useFormStatus();
  const [remaining, setRemaining] = useState(0);
  const retryAt = useRef(0);

  useEffect(() => {
    if (!remaining) return;
    const timer = setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((retryAt.current - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  function resend() {
    if (pending || formPending || Date.now() < retryAt.current) return;
    const formData = new FormData();
    formData.set("email", getEmail ? getEmail() : email);
    retryAt.current = Date.now() + CONFIRMATION_RESEND_COOLDOWN_SECONDS * 1000;
    setRemaining(CONFIRMATION_RESEND_COOLDOWN_SECONDS);
    startTransition(() => action(formData));
  }

  return (
    <div className="space-y-3">
      <Button type="button" variant="secondary" onClick={resend} disabled={pending || formPending || remaining > 0}>
        {pending ? "Sending confirmation…" : "Resend confirmation email"}
      </Button>
      {remaining > 0 ? <p className="text-sm text-muted-foreground">You can request another email in {remaining} seconds.</p> : null}
      <FormMessage>{state.formError ?? state.fieldErrors?.email}</FormMessage>
      {state.success ? <p role="status" className="text-sm text-muted-foreground">{state.success}</p> : null}
    </div>
  );
}
