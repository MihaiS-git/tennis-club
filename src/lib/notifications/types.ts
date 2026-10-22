export const emailDeliveryStatuses = ["pending", "processing", "accepted", "sandbox_accepted", "failed"] as const;
export type EmailDeliveryStatus = typeof emailDeliveryStatuses[number];

export type NotificationAccount = {
  userId: string;
  email: string;
  authEmail: string | null;
  emailConfirmed: boolean;
  active: boolean;
  roles: string[];
};

export type NotificationPurpose = "customer" | "admin_operational";
