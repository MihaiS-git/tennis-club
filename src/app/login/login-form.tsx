"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { PasswordInput } from "@/components/password-input";
import { initialAuthActionState } from "@/lib/auth/action-state";
import { signIn } from "@/lib/auth/actions";
import { authErrors } from "@/lib/auth/messages";

type LoginFormProps = {
  initialError?: string;
  message?: string;
};

export function LoginForm({ initialError, message }: LoginFormProps) {
  const [state, formAction] = useActionState(signIn, initialAuthActionState);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      {message ? (
        <p
          className="mt-6 rounded-control bg-success-background px-4 py-3 text-sm text-success"
          role="status"
        >
          {message}
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
          <div className="flex items-center justify-between gap-4">
            <label className="text-sm font-medium" htmlFor="password">
              Password
            </label>
            <Link
              className="text-sm font-medium text-primary hover:underline"
              href="/forgot-password"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            autoComplete="current-password"
            containerClassName="mt-2"
            id="password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            required
            value={password}
          />
        </div>
        <button
          className="w-full rounded-control bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary-hover"
          type="submit"
        >
          Sign in
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Need an account?{" "}
        <Link className="font-medium text-primary hover:underline" href="/signup">
          Sign up
        </Link>
      </p>
    </>
  );
}
