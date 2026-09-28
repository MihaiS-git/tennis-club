export const MAX_AVATAR_SIZE = 5 * 1024 * 1024;
const formats = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
} as const;
export type AvatarMime = keyof typeof formats;

export async function validateAvatar(file: File) {
  if (!file.size) return { ok: false, error: "Choose an image to upload." } as const;
  if (file.size > MAX_AVATAR_SIZE) return { ok: false, error: "Use an image no larger than 5 MiB." } as const;
  if (file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
    return { ok: false, error: "Choose a JPEG, PNG, or WebP image." } as const;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  const webp = bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF"
    && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!(file.type === "image/jpeg" ? jpeg : file.type === "image/png" ? png : webp)) {
    return { ok: false, error: "The image contents do not match its file type." } as const;
  }
  return { ok: true, bytes, mime: file.type, extension: formats[file.type] } as const;
}
