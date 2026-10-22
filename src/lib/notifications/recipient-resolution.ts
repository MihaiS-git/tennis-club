import "server-only";

import type { EntityManager } from "typeorm";
import { z } from "zod";
import type { NotificationAccount } from "./types";

const accountRows = z.array(z.object({
  user_id: z.uuid(), email: z.string(), auth_email: z.string().nullable(),
  email_confirmed: z.boolean(), active: z.boolean(), role_code: z.string().nullable(),
}));

export async function resolveNotificationAccounts(manager: EntityManager, email: string): Promise<NotificationAccount[]> {
  const rows: unknown = await manager.query(`
    SELECT u.id AS user_id, u.email, a.email AS auth_email,
      (a.email_confirmed_at IS NOT NULL) AS email_confirmed, (u.status = 'active') AS active, r.role_code
    FROM public.users u
    JOIN auth.users a ON a.id = u.id
    LEFT JOIN public.user_roles r ON r.user_id = u.id
    WHERE lower(u.email) = lower($1) OR lower(a.email) = lower($1)
    ORDER BY u.id, r.role_code`, [email]);
  const accounts = new Map<string, NotificationAccount>();
  for (const row of accountRows.parse(rows)) {
    const account = accounts.get(row.user_id) ?? { userId: row.user_id, email: row.email,
      authEmail: row.auth_email, emailConfirmed: row.email_confirmed, active: row.active, roles: [] };
    if (row.role_code) account.roles.push(row.role_code);
    accounts.set(row.user_id, account);
  }
  return [...accounts.values()];
}
