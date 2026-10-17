import { UserAreaShell } from "@/components/management-shell";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <UserAreaShell>
    <h1 className="font-heading text-3xl font-semibold text-primary">Profile</h1>
    <p className="mt-2 mb-6 text-sm text-muted-foreground">Your player identity, personal details and account settings.</p>
    {children}
  </UserAreaShell>;
}
