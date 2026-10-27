import { LoaderCircle } from "lucide-react";

export function Spinner({ size = "medium" }: { size?: "small" | "medium" | "compact" }) {
  return <LoaderCircle aria-hidden="true" className={`shrink-0 motion-safe:animate-spin ${size === "compact" ? "size-2.5" : size === "small" ? "size-3.5" : "size-4"}`} />;
}
