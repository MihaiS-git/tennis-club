import "server-only";

import { cache } from "react";
import { getDataSource } from "@/lib/db/data-source";
import { readAvatarMetadata } from "@/lib/db/repositories/avatars.repository";
import { logger } from "@/lib/logger";
import { profileContext } from "./profile";
import { playerAvatarUrl } from "./presentation";

// Share this authenticated read between desktop and mobile in one server render.
export const readNavigationProfile = cache(async () => {
  const { account } = await profileContext();
  if (account.state !== "active") return { account, avatarUrl: null };
  try {
    const { manager } = await getDataSource();
    const profile = await readAvatarMetadata(manager, account.userId);
    const metadata = profile && profile.avatar_path === `${account.userId}/avatar.webp`
      ? profile : null;
    return { account, avatarUrl: playerAvatarUrl(metadata) };
  } catch {
    logger.error({ event: "profile.navigation_avatar_failed" }, "Failed to load navigation avatar");
    return { account, avatarUrl: null };
  }
});
