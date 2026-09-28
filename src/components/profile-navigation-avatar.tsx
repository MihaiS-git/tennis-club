"use client";

import Link from "next/link";
import { UserRound } from "lucide-react";
import { useState } from "react";

export function ProfileNavigationAvatar({ src, desktop = false }: { src: string | null; desktop?: boolean }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hasAvatar = src && failedSrc !== src;
  const content = hasAvatar
    // eslint-disable-next-line @next/next/no-img-element -- This authenticated endpoint intentionally uses a native image.
    ? <img src={src} alt="" width={desktop ? 36 : 28} height={desktop ? 36 : 28} loading="lazy" decoding="async"
        className={`${desktop ? "size-9" : "size-7"} shrink-0 rounded-full object-cover object-center`} onError={() => setFailedSrc(src)} />
    : <UserRound aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.8} />;
  if (!desktop) return content;
  return <Link href="/profile" aria-label="Your profile"
    className={hasAvatar
      ? "inline-flex size-9 shrink-0 items-center justify-center rounded-full ring-1 ring-border transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      : "inline-flex size-10 items-center justify-center rounded-control border border-border-strong text-primary hover:bg-surface-muted hover:text-accent"}>
    {content}
  </Link>;
}
