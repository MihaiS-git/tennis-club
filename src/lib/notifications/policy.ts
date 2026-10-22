import type { NotificationAccount, NotificationPurpose } from "./types";

export function resolveNotificationChannels(
  email: string,
  accounts: readonly NotificationAccount[],
  purpose: NotificationPurpose,
) {
  const normalized = email.trim().toLowerCase();
  const matching = accounts.filter((account) =>
    account.email.toLowerCase() === normalized || account.authEmail?.toLowerCase() === normalized);
  const employees = matching.some((account) => account.roles.includes("admin") || account.roles.includes("coach"));
  const recipients = matching.filter((account) => account.active && account.emailConfirmed &&
    account.email.toLowerCase() === normalized && account.authEmail?.toLowerCase() === normalized &&
    (purpose !== "admin_operational" || account.roles.includes("admin")));
  return {
    email: purpose === "customer" && !employees,
    userIds: [...new Set(recipients.map((account) => account.userId))],
  };
}
