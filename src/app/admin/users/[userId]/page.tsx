import { notFound } from "next/navigation";
import { z } from "zod";
import { AdminPageHeader } from "@/components/admin-page-controls";
import { requireActiveAdmin } from "@/lib/admin/authorization";
import { readAdminUserDetails } from "@/lib/admin/users";
import { RoleChips, StatusBadge } from "../user-item";
import { UserWorkspace } from "../user-workspace";

export const instant = false;

export default async function UserManagementPage({ params }: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActiveAdmin();
  const parsed = z.uuid().safeParse((await params).userId);
  if (!parsed.success) notFound();
  const user = await readAdminUserDetails(parsed.data);
  if (!user) notFound();
  const fullName = [user.personal.first_name, user.personal.last_name].filter(Boolean).join(" ");
  const displayName = fullName || user.player?.display_name;
  return <>
    <div className="min-w-0 [overflow-wrap:anywhere] [&_p:empty]:hidden">
      <AdminPageHeader title={displayName || user.email} description={displayName ? user.email : null}>
        <div className="flex flex-wrap items-center gap-2 text-sm" aria-label="User account summary">
          <StatusBadge status={user.status} /><span className="text-muted-foreground">Assigned roles:</span>
          <RoleChips roles={user.roles} />
        </div>
      </AdminPageHeader>
    </div>
    <UserWorkspace key={user.id} user={user} currentAdminId={actor.userId} />
  </>;
}
