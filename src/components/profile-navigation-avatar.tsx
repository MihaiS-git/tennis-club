"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";

export function ProfileNavigationAvatar({ src }: { src: string | null }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const hasAvatar = src && failedSrc !== src;
  const content = hasAvatar
    // eslint-disable-next-line @next/next/no-img-element -- This authenticated endpoint intentionally uses a native image.
    ? <img src={src} alt="" width={48} height={48} loading="lazy" decoding="async"
        className="size-12 shrink-0 rounded-full object-cover object-center" onError={() => setFailedSrc(src)} />
    : <UserRound aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.8} />;
  return <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full">{content}</span>;
}
