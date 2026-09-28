export const MAX_AVATAR_SIZE = 5 * 1024 * 1024;

// Browser feedback only; the server repeats these checks before decoding.
export function avatarFileError(file: File | undefined) {
  if (!(file instanceof File) || !file.size) return "Choose an image to upload.";
  if (file.size > MAX_AVATAR_SIZE) return "Use an image no larger than 5 MiB.";
  if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
    return "Choose a JPEG, PNG, or WebP image.";
  }
}
