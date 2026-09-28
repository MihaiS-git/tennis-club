import "server-only";

import sharp from "sharp";
import { avatarFileError } from "./avatar-file-validation";

export { MAX_AVATAR_SIZE } from "./avatar-file-validation";
const MAX_DIMENSION = 12_000;
const MAX_PIXELS = 40_000_000;
const dimensionError = "Use an image no larger than 12,000 pixels per side and 40 million pixels in total.";

export async function validateAvatar(file: File) {
  const error = avatarFileError(file);
  if (error) return { ok: false, error } as const;
  try {
    const input = Buffer.from(await file.arrayBuffer());
    // Decode only the first frame. Never disable the decoder's safety limits.
    const image = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "warning", pages: 1 });
    const metadata = await image.metadata();
    const { width, height } = metadata;
    if (!width || !height || width <= 0 || height <= 0 || width > MAX_DIMENSION
      || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
      return { ok: false, error: dimensionError } as const;
    }
    const expectedFormat = file.type === "image/jpeg" ? "jpeg" : file.type === "image/png" ? "png" : "webp";
    if (metadata.format !== expectedFormat) {
      return { ok: false, error: "The image contents do not match its file type." } as const;
    }
    // toBuffer actually decodes the pixels; metadata/signatures alone are insufficient.
    // Sharp strips source metadata by default.
    const bytes = await image.rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 }).timeout({ seconds: 10 }).toBuffer();
    return { ok: true, bytes } as const;
  } catch (cause) {
    const pixelLimit = cause instanceof Error && cause.message.includes("pixel limit");
    return { ok: false, error: pixelLimit ? dimensionError : "Choose a valid JPEG, PNG, or WebP image." } as const;
  }
}
