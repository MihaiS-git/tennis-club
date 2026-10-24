import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { DataSource } from "typeorm";
import { expect, test } from "@playwright/test";
import { localServiceRoleKey } from "./helpers/supabase";

test("message opens as read and can be marked unread from the navbar", async ({ page }) => {
  const service = createClient(process.env.SUPABASE_URL!, localServiceRoleKey(),
    { auth: { persistSession: false, autoRefreshToken: false } });
  const database = await new DataSource({ type: "postgres", url: process.env.DATABASE_URL }).initialize();
  const email = `messages-browser-${randomUUID()}@example.test`;
  const password = "Messages-browser-123";
  const messageId = randomUUID();
  let userId: string | undefined;
  try {
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    userId = created.data.user?.id;
    expect(created.error).toBeNull();
    await database.query(`INSERT INTO public.user_messages
      (id,user_id,event_key,kind,subject,body_text,created_at)
      VALUES($1,$2,$3,'booking.confirmed','Browser notification','Your booking is confirmed.',clock_timestamp())`,
    [messageId, userId, `browser:${messageId}`]);
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/messages");
    await expect(page.getByRole("link", { name: /Browser notification/ })).toBeVisible();
    await page.getByRole("link", { name: /Browser notification/ }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${messageId}`));
    await expect.poll(async () => (await database.query("SELECT read_at FROM public.user_messages WHERE id=$1", [messageId]))[0].read_at)
      .not.toBeNull();
    await expect(page.getByRole("link", { name: "Notifications", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Mark unread" }).click();
    await expect(page).toHaveURL(/\/messages(?:\?page=1)?$/);
    await expect.poll(async () => (await database.query("SELECT read_at FROM public.user_messages WHERE id=$1", [messageId]))[0].read_at)
      .toBeNull();
    await expect.poll(async () => page.evaluate(async () => {
      const response = await fetch("/api/messages/unread-count", { cache: "no-store" });
      return { status: response.status, data: await response.json() };
    })).toEqual({ status: 200, data: { unreadCount: 1 } });
    await expect(page.getByRole("link", { name: "Notifications, unread messages" }).first()).toBeVisible();
  } finally {
    // Soft checks keep a test failure primary, report each cleanup failure and still run the rest.
    try {
      await expect.soft(database.query("DELETE FROM public.user_messages WHERE id=$1", [messageId]), "delete message").resolves.toBeDefined();
      if (userId) {
        await expect.soft(database.query("DELETE FROM public.users WHERE id=$1", [userId]), "delete application user").resolves.toBeDefined();
        await expect.soft(service.auth.admin.deleteUser(userId), "delete Auth user").resolves.toMatchObject({ error: null });
      }
    } finally {
      await database.destroy();
    }
  }
});
