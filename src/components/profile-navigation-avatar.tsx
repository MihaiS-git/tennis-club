"use client";

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
  return content;
}
