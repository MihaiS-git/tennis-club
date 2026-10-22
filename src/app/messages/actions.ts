"use server";

import { revalidatePath } from "next/cache";
import { deleteOwnMessage, messageAccess, readOwnMessage, unreadOwnMessage, updateOwnMessages } from "@/lib/notifications/inbox";

export async function markMessageReadAction(id: unknown) {
  const access = await messageAccess();
  if (access.state !== "ready") throw new Error("Authentication required");
  if (!await readOwnMessage(access.userId, id)) throw new Error("Notification unavailable");
  revalidatePath("/messages");
  return { ok: true };
}

export async function markMessageUnreadAction(id: unknown) {
  const access = await messageAccess();
  if (access.state !== "ready") throw new Error("Authentication required");
  if (!await unreadOwnMessage(access.userId, id)) throw new Error("Notification unavailable");
  revalidatePath("/messages");
  return { ok: true };
}

export async function updateSelectedMessagesAction(ids: unknown, operation: "read" | "unread" | "delete") {
  const access = await messageAccess();
  if (access.state !== "ready") throw new Error("Authentication required");
  if (operation !== "read" && operation !== "unread" && operation !== "delete") throw new Error("Invalid notification action");
  const updated = await updateOwnMessages(access.userId, ids, operation);
  revalidatePath("/messages");
  return { updated };
}

export async function deleteMessageAction(id: unknown) {
  const access = await messageAccess();
  if (access.state !== "ready") throw new Error("Authentication required");
  if (!await deleteOwnMessage(access.userId, id)) throw new Error("Notification unavailable");
  revalidatePath("/messages");
  return { ok: true };
}
