import { UserAreaShell } from "@/components/management-shell";

export default function MessagesLayout({ children }: { children: React.ReactNode }) {
  return <UserAreaShell>{children}</UserAreaShell>;
}
