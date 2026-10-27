import { Suspense } from "react";

import { LoadingStatus } from "@/components/loading-status";
import { AdminEntryRedirect } from "./admin-entry-redirect";

export default function AdminPage() {
  // The Admin layout's boundary only covers entering the area. Navigations within it
  // keep that layout mounted, so the role lookup needs its own page-level boundary.
  return <Suspense fallback={<LoadingStatus variant="page" label="Loading management area…" />}>
    <AdminEntryRedirect />
  </Suspense>;
}
