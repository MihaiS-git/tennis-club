"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

export function ActionFeedback({ state, loading }: {
  state: { formError?: string; success?: string; fieldErrors?: Record<string, string | undefined> };
  loading: string;
}) {
  const { pending } = useFormStatus();
  const notification = useRef<string | number | undefined>(undefined);
  const previous = useRef(state);
  useEffect(() => {
    if (pending) {
      if (notification.current === undefined) notification.current = toast.loading(loading);
      return;
    }
    if (previous.current !== state) {
      previous.current = state;
      if (Object.values(state.fieldErrors ?? {}).some(Boolean)) {
        if (notification.current !== undefined) toast.dismiss(notification.current);
      } else if (state.formError) toast.error(state.formError, { id: notification.current });
      else if (state.success) toast.success(state.success, { id: notification.current });
      else if (notification.current !== undefined) toast.dismiss(notification.current);
      notification.current = undefined;
    } else if (notification.current !== undefined) {
      toast.dismiss(notification.current);
      notification.current = undefined;
    }
  }, [pending, state, loading]);
  useEffect(() => () => { if (notification.current !== undefined) toast.dismiss(notification.current); }, []);
  return null;
}
