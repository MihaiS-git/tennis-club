"use client";

import { ManagementTableToolbar } from "@/components/management-table-toolbar";

export function UsersToolbar() {
  return <ManagementTableToolbar searchLabel="Email search" placeholder="Search by email" controls={[
    { name: "status", label: "Status", options: [{ value: "", label: "All statuses" }, { value: "active", label: "Active" }, { value: "suspended", label: "Suspended" }] },
    { name: "role", label: "Role", options: [{ value: "", label: "All roles" }, { value: "coach", label: "Coach" }, { value: "admin", label: "Admin" }] },
  ]} />;
}
