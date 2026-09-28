import "server-only";

import { logger } from "@/lib/logger";
import { profileContext, type ProfileClient } from "./profile";
import { validateAvatar } from "./avatar-validation";
import type { ProfileActionState } from "./validation";

export const AVATAR_BUCKET = "profile-avatars";

function isOwnAvatarPath(userId: string, path: string) {
  return ["jpg", "png", "webp"].some((extension) => path === `${userId}/avatar.${extension}`);
}

export async function readPlayerAvatar(suppliedClient?: ProfileClient): Promise<
  { kind: "unauthenticated" | "forbidden" | "not-found" | "error" } | { kind: "image"; file: Blob }
> {
  const { client, account } = await profileContext(suppliedClient);
  if (account.state === "unauthenticated") return { kind: "unauthenticated" };
  if (account.state !== "active") return { kind: "forbidden" };
  const profile = await client.from("player_profiles").select("avatar_path").eq("user_id", account.userId).maybeSingle();
  if (profile.error) {
    logger.error({ event: "profile.avatar_read_failed", stage: "profile", code: profile.error.code }, "Failed to read avatar");
    return { kind: "error" };
  }
  const path = profile.data?.avatar_path;
  if (typeof path !== "string" || !isOwnAvatarPath(account.userId, path)) return { kind: "not-found" };
  const result = await client.storage.from(AVATAR_BUCKET).download(path);
  if (result.error || !result.data || !["image/jpeg", "image/png", "image/webp"].includes(result.data.type)) {
    logger.error({ event: "profile.avatar_read_failed", stage: "storage" }, "Failed to read avatar");
    return { kind: "error" };
  }
  return { kind: "image", file: result.data };
}

// Storage and PostgREST cannot share a transaction. Keep a copy of the previous
// object until persistence succeeds, and compensate failed changes where possible.
export async function changeAvatar(file: File | null, suppliedClient?: ProfileClient): Promise<ProfileActionState> {
  const { client, account } = await profileContext(suppliedClient);
  if (account.state !== "active") return { formError: "Avatar changes require an active account." };
  const image = file ? await validateAvatar(file) : null;
  if (image && !image.ok) return { fieldErrors: { avatar: image.error } };
  const profile = await client.from("player_profiles").select("avatar_path").eq("user_id", account.userId).maybeSingle();
  if (profile.error) return failure("load");
  if (!profile.data) return { formError: "Save your tennis profile before uploading an avatar." };
  const oldPath = typeof profile.data.avatar_path === "string" ? profile.data.avatar_path : null;
  if (oldPath && !isOwnAvatarPath(account.userId, oldPath)) {
    return failure("invalid_path");
  }
  const bucket = client.storage.from(AVATAR_BUCKET);
  const backup = oldPath ? await bucket.download(oldPath) : null;
  if (backup?.error) return failure("backup");
  const newPath = image?.ok ? `${account.userId}/avatar.${image.extension}` : null;
  const savePath = async (path: string | null) => {
    const result = await client.from("player_profiles").update({ avatar_path: path, updated_at: new Date().toISOString() })
      .eq("user_id", account.userId).select("user_id").maybeSingle();
    return !result.error && Boolean(result.data);
  };
  const restoreOldObject = async () => {
    if (!oldPath || !backup?.data) return true;
    const restored = await bucket.upload(oldPath, backup.data, { upsert: true, contentType: backup.data.type });
    return !restored.error;
  };

  if (image?.ok && newPath) {
    const uploaded = await bucket.upload(newPath, image.bytes, { contentType: image.mime, upsert: true, cacheControl: "0" });
    if (uploaded.error) return failure("upload");
    if (!(await savePath(newPath))) {
      const rollback = newPath === oldPath ? await restoreOldObject() : !(await bucket.remove([newPath])).error;
      return failure(rollback ? "save" : "save_rollback_failed");
    }
    if (oldPath && oldPath !== newPath) {
      const removed = await bucket.remove([oldPath]);
      if (removed.error) {
        // Restore the old reference before deleting the new object.
        const reverted = await restoreOldObject() && await savePath(oldPath);
        const cleaned = reverted && !(await bucket.remove([newPath])).error;
        return failure(cleaned ? "replace_cleanup" : "replace_rollback_failed");
      }
    }
    return { success: "Avatar saved." };
  }

  if (!oldPath) return { success: "Avatar removed." };
  if ((await bucket.remove([oldPath])).error) return failure("remove");
  if (!(await savePath(null))) {
    return failure(await restoreOldObject() ? "remove_save" : "remove_rollback_failed");
  }
  return { success: "Avatar removed." };
}

function failure(stage: string): ProfileActionState {
  logger.error({ event: "profile.avatar_change_failed", stage }, "Failed to change avatar");
  return { formError: "We couldn't complete the avatar change. Reload your profile and try again." };
}
