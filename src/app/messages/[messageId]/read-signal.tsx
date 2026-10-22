"use client";

import { useEffect, useRef, useState } from "react";
import { markMessageReadAction } from "../actions";

export function MessageReadSignal({ id }: { id: string }) {
  const opened = useRef(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void markMessageReadAction(id).then(() => {
      window.dispatchEvent(new Event("messages:changed"));
    }).catch(() => setError(true));
  }, [id]);
  return error ? <p role="alert" className="text-sm text-red-700">Unable to mark this notification read.</p> : null;
}
