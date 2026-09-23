"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { PasswordInput } from "@/components/password-input";
import { initialAuthActionState } from "@/lib/auth/action-state";
import { signUp } from "@/lib/auth/actions";
import { authErrors } from "@/lib/auth/messages";

type SignupFormProps = {
  initialError?: string;
};

export function SignupForm({ initialError }: SignupFormProps) {
  const [state, formAction] = useActionState(signUp, initialAuthActionState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [dismissedErrorAttempt, setDismissedErrorAttempt] = useState<
    number | undefined
  >(undefined);

  const error = dismissedErrorAttempt === state.attempt
    ? undefined
    : state.error
      ? authErrors[state.error]
      : initialError;

  return (
    <>
      {error ? (
        <p
          className="mt-6 rounded-control bg-danger-background px-4 py-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <form
        action={formAction}
        className="mt-6 space-y-5"
        onInput={() => setDismissedErrorAttempt(state.attempt)}
      >
        <div>
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            autoComplete="email"
            className="mt-2 w-full rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-focus/20"
            id="email"
            name="email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="password">
            Password
          </label>
          <PasswordInput
            autoComplete="new-password"
            containerClassName="mt-2"
            id="password"
            maxLength={72}
            minLength={8}
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            value={password}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Use 8 to 72 characters.
          </p>
        </div>
        <div>
          <label className="text-sm font-medium" htmlFor="confirmPassword">
            Confirm password
          </label>
          <PasswordInput
            autoComplete="new-password"
            containerClassName="mt-2"
            id="confirmPassword"
            maxLength={72}
            minLength={8}
            name="confirmPassword"
            onChange={(event) => setConfirmPassword(event.target.value)}
            required
            value={confirmPassword}
          />
        </div>
        <button
          className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
          type="submit"
        >
          Create account
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already registered?{" "}
        <Link className="font-medium text-primary hover:underline" href="/login">
          Sign in
        </Link>
      </p>
    </>
  );
}
