import { UserAreaShell } from "@/components/management-shell";

export default function MyActivityLayout({ children }: { children: React.ReactNode }) {
  return <UserAreaShell>
    <h1 className="font-heading text-3xl font-semibold text-primary">My activity</h1>
    <p className="mt-2 mb-6 text-sm text-muted-foreground">Your upcoming activity, club history and notifications.</p>
    {children}
  </UserAreaShell>;
}
