export function effectiveDisplayName(displayName: string | null | undefined, personal: {
  first_name?: string | null; last_name?: string | null;
}) {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
  return normalize(displayName ?? "") || normalize(`${personal.first_name ?? ""} ${personal.last_name ?? ""}`);
}

export function playerAvatarUrl(player: { avatar_path: string | null; updated_at: string } | null) {
  return player?.avatar_path ? `/profile/avatar?v=${encodeURIComponent(player.updated_at)}` : null;
}

export const tennisChoices = {
  handedness: [["right", "Right-handed"], ["left", "Left-handed"]],
  backhand: [["one_handed", "One-handed"], ["two_handed", "Two-handed"]],
  preferred_game: [["singles", "Singles"], ["doubles", "Doubles"], ["both", "Both"]],
  preferred_surface: [["clay", "Clay"], ["hard", "Hard"], ["grass", "Grass"], ["carpet", "Carpet"], ["any", "Any"]],
} as const;
export const tennisChoiceLabels = { handedness: "Handedness", backhand: "Backhand", preferred_game: "Preferred game", preferred_surface: "Preferred surface" } as const;
export const tennisChoiceNames = ["handedness", "backhand", "preferred_game", "preferred_surface"] as const;

export function tennisChoiceLabel(name: typeof tennisChoiceNames[number], value: string | null | undefined) {
  return (tennisChoices[name] as readonly (readonly [string, string])[]).find(([choice]) => choice === value)?.[1] ?? null;
}
