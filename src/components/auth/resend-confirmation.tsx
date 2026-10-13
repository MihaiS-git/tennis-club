"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import { resendConfirmationAction } from "@/app/(auth)/actions";
import { Button } from "@/components/button";
import { initialAuthActionState } from "@/lib/auth/action-state";
import { CONFIRMATION_RESEND_COOLDOWN_SECONDS } from "@/lib/auth/confirmation";

export function ResendConfirmation({ email, getEmail, onEmailError }: ({ email: string; getEmail?: never } | { email?: never; getEmail: () => string }) & {
  onEmailError?: (error: string | undefined) => void;
}) {
  const [, action, pending] = useActionState(async (previous: typeof initialAuthActionState, data: FormData) => {
    const notification = toast.loading("Sending confirmation email…");
    try {
      const result = await resendConfirmationAction(previous, data);
      onEmailError?.(result.fieldErrors?.email);
      if (result.formError) toast.error(result.formError, { id: notification });
      else if (result.success) toast.success(result.success, { id: notification });
      else if (result.fieldErrors?.email && !onEmailError) toast.error(result.fieldErrors.email, { id: notification });
      else toast.dismiss(notification);
      return result;
    } catch {
      const formError = "We could not request a confirmation email. Please try again later.";
      toast.error(formError, { id: notification });
      return { formError };
    }
  }, initialAuthActionState);
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
      <p className="min-h-5 text-sm text-muted-foreground">{remaining > 0 ? `You can request another email in ${remaining} seconds.` : ""}</p>
    </div>
  );
}
