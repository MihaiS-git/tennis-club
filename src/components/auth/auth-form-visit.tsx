"use client";

import { Fragment, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export function AuthFormVisit({ children }: { children: ReactNode }) {
  const { bfcacheId } = useRouter();
  // Fresh link navigations must not restore an earlier form's credentials or feedback.
  return <Fragment key={bfcacheId}>{children}</Fragment>;
}
