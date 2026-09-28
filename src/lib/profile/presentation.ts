export function effectiveDisplayName(displayName: string | null | undefined, personal: {
  first_name?: string | null; last_name?: string | null;
}) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  return normalize(displayName ?? "") || normalize(`${personal.first_name ?? ""} ${personal.last_name ?? ""}`);
}

export function playerAvatarUrl(player: { avatar_path: string | null; updated_at: string } | null) {
  return player?.avatar_path ? `/profile/avatar?v=${encodeURIComponent(player.updated_at)}` : null;
}
