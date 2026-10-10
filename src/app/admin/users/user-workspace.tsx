"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { SegmentedNavigation, segmentedNavigationItemClass } from "@/components/segmented-navigation";
import type { AdminUserDetails } from "@/lib/admin/users";
import { UserAccessControls } from "./user-access-controls";
import { UserProfileDetails } from "./user-profile-details";

const tabs = [
  { id: "account", label: "Account & access" },
  { id: "personal", label: "Personal profile" },
  { id: "tennis", label: "Tennis profile" },
] as const;

export function UserWorkspace({ user, currentAdminId }: { user: AdminUserDetails; currentAdminId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.getAll("tab");
  const selected = requested.length === 1 && tabs.some(({ id }) => id === requested[0]) ? requested[0] : "account";
  return <>
    <SegmentedNavigation columns={3} aria-label="User management" className="mb-5">
      {tabs.map(({ id, label }) => {
        const query = new URLSearchParams(searchParams);
        query.set("tab", id);
        return <Link key={id} href={`${pathname}?${query}`} scroll={false}
          aria-current={selected === id ? "page" : undefined} className={segmentedNavigationItemClass(selected === id)}>
          {label}
        </Link>;
      })}
    </SegmentedNavigation>
    <section aria-label="Account & access" hidden={selected !== "account"}
      className="rounded-control border border-border bg-surface p-4 sm:p-6">
      <UserAccessControls user={user} currentAdminId={currentAdminId} />
    </section>
    {selected !== "account" && <section aria-label={selected === "personal" ? "Personal profile" : "Tennis profile"}
      className="rounded-control border border-border bg-surface p-4 sm:p-6">
      <UserProfileDetails user={user} section={selected === "personal" ? "personal" : "tennis"} />
    </section>}
  </>;
}
