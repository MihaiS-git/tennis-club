import "server-only";

import { logger } from "@/lib/logger";
import { profileContext, type ProfileClient } from "./profile";
import { validateAvatar } from "./avatar-validation";
import type { ProfileActionState } from "./validation";

export const AVATAR_BUCKET = "profile-avatars";

function isOwnAvatarPath(userId: string, path: string) {
  return path === `${userId}/avatar.webp`;
}

export async function readPlayerAvatar(suppliedClient?: ProfileClient): Promise<
  { kind: "unauthenticated" | "forbidden" | "not-found" | "error" } | { kind: "image"; file: Blob }
> {
  try {
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
    if (result.error || !result.data || result.data.type !== "image/webp") {
      logger.error({ event: "profile.avatar_read_failed", stage: "storage" }, "Failed to read avatar");
      return { kind: "error" };
    }
    return { kind: "image", file: result.data };
  } catch {
    logger.error({ event: "profile.avatar_read_failed", stage: "request" }, "Failed to read avatar");
    return { kind: "error" };
  }
}

// Storage and PostgREST cannot share a transaction. Keep a copy of the previous
// object until persistence succeeds, and compensate failed changes where possible.
export async function changeAvatar(file: File | null, suppliedClient?: ProfileClient): Promise<ProfileActionState> {
  try {
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
    if (oldPath && (backup?.error || !backup?.data || backup.data.type !== "image/webp")) return failure("backup");
    const path = `${account.userId}/avatar.webp`;
    const savePath = async (path: string | null) => {
      try {
        const result = await client.from("player_profiles").update({ avatar_path: path, updated_at: new Date().toISOString() })
          .eq("user_id", account.userId).select("user_id").maybeSingle();
        return !result.error && Boolean(result.data);
      } catch {
        return false;
      }
    };
    const restoreOldObject = async () => {
      try {
        if (!oldPath || !backup?.data) return false;
        const restored = await bucket.upload(path, backup.data, { upsert: true, contentType: "image/webp", cacheControl: "0" });
        return !restored.error;
      } catch {
        return false;
      }
    };

    if (image?.ok) {
      const uploaded = await bucket.upload(path, image.bytes, { contentType: "image/webp", upsert: true, cacheControl: "0" });
      if (uploaded.error) return failure("upload");
      if (!(await savePath(path))) {
        const rollback = oldPath ? await restoreOldObject() : !(await bucket.remove([path])).error;
        return failure(rollback ? "save" : "save_rollback_failed");
      }
      return { success: "Avatar saved." };
    }

    if (!oldPath) return { success: "Avatar removed." };
    if ((await bucket.remove([oldPath])).error) return failure("remove");
    if (!(await savePath(null))) {
      return failure(await restoreOldObject() ? "remove_save" : "remove_rollback_failed");
    }
    return { success: "Avatar removed." };
  } catch {
    return failure("request");
  }
}

function failure(stage: string): ProfileActionState {
  logger.error({ event: "profile.avatar_change_failed", stage }, "Failed to change avatar");
  return { formError: "We couldn't complete the avatar change. Reload your profile and try again." };
}
