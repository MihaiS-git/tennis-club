"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import {
  readFlashMessages,
  removeConsumedFlashMessages,
} from "@/lib/flash-messages";

export function QueryFlashMessages() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const consumedLocation = useRef<string | null>(null);

  useEffect(() => {
    const flashes = readFlashMessages(searchParams);
    if (flashes.length === 0) {
      consumedLocation.current = null;
      return;
    }

    const currentLocation = `${pathname}?${searchParams.toString()}`;
    if (consumedLocation.current === currentLocation) return;

    consumedLocation.current = currentLocation;
    flashes.forEach(({ kind, text }) => {
      if (kind === "success") toast.success(text);
      else toast.error(text);
    });

    const remaining = removeConsumedFlashMessages(searchParams);
    const destination = remaining ? `${pathname}?${remaining}` : pathname;
    router.replace(destination, { scroll: false });
  }, [pathname, router, searchParams]);

  return null;
}
