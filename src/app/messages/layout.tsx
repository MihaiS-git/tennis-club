import { AreaShell } from "@/components/management-shell";

// Notifications stay outside the My account sidebar.
export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <AreaShell>{children}</AreaShell>;
}
