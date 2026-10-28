import { LoadingStatus } from "@/components/loading-status";

export default function ProfileLoading() {
  // The loaded page is taller than this fallback, so keep the footer unpainted
  // (globals.css) rather than visibly moving when the page replaces it.
  return <>
    <LoadingStatus variant="page" label="Loading your profile…" />
    <span hidden data-defers-footer="" />
  </>;
}
