"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { setLocationPublicationAction } from "./actions";

export function PublicationControl({ id, published, blocked }: { id: string; published: boolean; blocked: boolean }) {
  const router = useRouter();
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError("");
    try {
      const result = await setLocationPublicationAction({ id, is_public: !published });
      if (result.ok) router.refresh();
      else setError(result.reason === "not-ready" ? result.message : "Unable to change public booking. Refresh and try again.");
    } catch { setError("Unable to change public booking. Please try again."); }
    finally { pendingRef.current = false; setPending(false); }
  }
  return <div className="mt-3">
    <Button type="button" fullWidth={false} disabled={pending || (!published && blocked)} aria-busy={pending} onClick={() => void save()}>
      {pending ? "Saving…" : published ? "Disable public booking" : "Enable public booking"}
    </Button>
    {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
  </div>;
}
