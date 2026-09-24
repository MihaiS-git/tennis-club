import type { ReactNode } from "react";

export function FormField({
  label,
  htmlFor,
  error,
  errorId,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  errorId: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">{label}</label>
      <div className="mt-1">{children}</div>
      {error ? <p id={errorId} role="alert" className="mt-1 text-sm font-normal text-danger">{error}</p> : null}
    </div>
  );
}
