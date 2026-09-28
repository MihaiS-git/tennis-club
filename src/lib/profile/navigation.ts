import "server-only";

import { cache } from "react";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { profileContext } from "./profile";
import { playerAvatarUrl } from "./presentation";

// Share this authenticated read between desktop and mobile in one server render.
export const readNavigationProfile = cache(async () => {
  const { client, account } = await profileContext();
  if (account.state !== "active") return { account, avatarUrl: null };
  const result = await client.from("player_profiles").select("avatar_path, updated_at")
    .eq("user_id", account.userId).maybeSingle();
  const parsed = z.object({ avatar_path: z.string().nullable(), updated_at: z.iso.datetime({ offset: true }) })
    .nullable().safeParse(result.data);
  if (result.error || !parsed.success) {
    logger.error({ event: "profile.navigation_avatar_failed", code: result.error?.code }, "Failed to load navigation avatar");
    return { account, avatarUrl: null };
  }
  return { account, avatarUrl: playerAvatarUrl(parsed.data) };
});
