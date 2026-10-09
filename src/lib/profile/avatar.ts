import "server-only";

import { unstable_rethrow } from "next/navigation";
import { getDataSource } from "@/lib/db/data-source";
import { inTransaction } from "@/lib/db/transaction";
import { readAvatarOwner, readAvatarReference, writeAvatarPath } from "@/lib/db/repositories/avatars.repository";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { profileContext, type ProfileClient } from "./profile";
import { validateAvatar } from "./avatar-validation";
import { avatarTransport } from "./avatar-transport";
import { z } from "zod";
import type { ProfileActionState } from "./validation";

export const AVATAR_BUCKET = "profile-avatars";

function isOwnAvatarPath(userId: string, path: string) {
  return path === `${userId}/avatar.webp`;
}

export async function readPlayerAvatar(suppliedClient?: ProfileClient, adminTargetUserId?: string): Promise<
  { kind: "unauthenticated" | "forbidden" | "not-found" | "error" } | { kind: "image"; file: Blob }
> {
  try {
    const { client, account } = await profileContext(suppliedClient ?? await createClient(avatarTransport()));
    if (account.state === "unauthenticated") return { kind: "unauthenticated" };
    if (account.state !== "active") return { kind: "forbidden" };
    if (adminTargetUserId !== undefined && !account.roles.includes("admin")) return { kind: "forbidden" };
    const userId = adminTargetUserId ?? account.userId;
    if (adminTargetUserId !== undefined && !z.uuid().safeParse(userId).success) return { kind: "not-found" };
    const { manager } = await getDataSource();
    const profile = await readAvatarReference(manager, userId);
    const path = profile?.avatarPath;
    if (typeof path !== "string" || !isOwnAvatarPath(userId, path)) return { kind: "not-found" };
    const result = await client.storage.from(AVATAR_BUCKET).download(path);
    if (result.error || !result.data || result.data.type !== "image/webp") {
      logger.error({ event: "profile.avatar_read_failed", stage: "storage" }, "Failed to read avatar");
      return { kind: "error" };
    }
    return { kind: "image", file: result.data };
  } catch (error) {
    unstable_rethrow(error);
    logger.error({ event: "profile.avatar_read_failed", stage: "request" }, "Failed to read avatar");
    return { kind: "error" };
  }
}

// Storage and PostgreSQL are independent. Keep transactions short and accept
// rare canonical-object races rather than coordinating a distributed workflow.
export async function changeAvatar(file: File | null): Promise<ProfileActionState> {
  try {
    const client = await createClient(avatarTransport());
    const { account } = await profileContext(client);
    if (account.state !== "active") return { formError: "Avatar changes require an active account." };
    const { manager } = await getDataSource();
    const facts = await readAvatarOwner(manager, account.userId);
    if (facts.owner?.status !== "active") return { formError: "Avatar changes require an active account." };
    if (!facts.profile) return { formError: "Save your tennis profile before uploading an avatar." };
    const oldPath = facts.profile.avatarPath;
    const path = `${account.userId}/avatar.webp`;
    if (oldPath !== null && !isOwnAvatarPath(account.userId, oldPath)) return failure("invalid_path");
    const image = file ? await validateAvatar(file) : null;
    if (image && !image.ok) return { fieldErrors: { avatar: image.error } };
    const bucket = client.storage.from(AVATAR_BUCKET);
    const savePath = (nextPath: string | null) => inTransaction(async (transaction) => {
      const locked = await readAvatarOwner(transaction, account.userId, true);
      if (locked.owner?.status !== "active" || !locked.profile) throw new Error("Avatar owner unavailable");
      if (locked.profile.avatarPath !== null && !isOwnAvatarPath(account.userId, locked.profile.avatarPath)) {
        throw new Error("Invalid avatar reference");
      }
      if (!await writeAvatarPath(transaction, account.userId, nextPath)) throw new Error("Avatar profile unavailable");
    });

    if (image?.ok) {
      const uploaded = await bucket.upload(path, image.bytes, { contentType: "image/webp", upsert: true, cacheControl: "0" });
      if (uploaded.error) return failure("upload");
      try {
        await savePath(path);
      } catch {
        // Initial uploads alone get best-effort cleanup. Replacements keep the
        // new bytes at the unchanged canonical reference, without a backup.
        if (oldPath === null) {
          try { await bucket.remove([path]); } catch { /* An orphan is acceptable. */ }
        }
        return failure("save");
      }
      return { success: "Avatar saved." };
    }

    if (oldPath === null) return { success: "Avatar removed." };
    await savePath(null);
    // The reference stays cleared even if deletion fails or its response is lost.
    // Return success for the committed visible removal so actions revalidate UI.
    try {
      if ((await bucket.remove([path])).error) failure("remove_storage");
    } catch { failure("remove_storage"); }
    return { success: "Avatar removed." };
  } catch {
    return failure("request");
  }
}

function failure(stage: string): ProfileActionState {
  logger.error({ event: "profile.avatar_change_failed", stage }, "Failed to change avatar");
  return { formError: "We couldn't complete the avatar change. Reload your profile and try again." };
}
