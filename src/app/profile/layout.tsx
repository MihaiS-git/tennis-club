import { UserAreaShell } from "@/components/management-shell";

export default function ProfileLayout({ children }: { children: React.ReactNode }) {
  return <UserAreaShell>
    <div className="space-y-6 lg:space-y-8">
      <header>
        <p className="text-sm font-medium text-accent">Your club profile</p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Profile</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Manage your player identity, personal details and account settings.</p>
      </header>
      {children}
    </div>
  </UserAreaShell>;
}
