import sharp from "sharp";
import { expect, it } from "vitest";
import { MAX_AVATAR_SIZE, validateAvatar } from "../../../src/lib/profile/avatar-validation";

const source = (width = 1024, height = 512) => sharp({ create: { width, height, channels: 3, background: "red" } });
const file = (bytes: Uint8Array, type = "image/png", name = "untrusted.exe") => new File([new Uint8Array(bytes)], name, { type });

it.each(["jpeg", "png", "webp"] as const)("decodes %s sources and produces a bounded WebP preserving aspect ratio", async (format) => {
  const input = await source().toFormat(format).toBuffer();
  const result = await validateAvatar(file(input, `image/${format}`));
  if (!result.ok) throw new Error(result.error);
  expect(result.bytes.equals(input)).toBe(false);
  expect(await sharp(result.bytes).metadata()).toMatchObject({ format: "webp", width: 512, height: 256 });
  await expect(sharp(result.bytes).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
});

it.each([[80, 40], [40, 80], [512, 512]])("does not enlarge or crop a %i × %i image", async (width, height) => {
  const result = await validateAvatar(file(await source(width, height).png().toBuffer()));
  if (!result.ok) throw new Error(result.error);
  expect(await sharp(result.bytes).metadata()).toMatchObject({ width, height });
});

it("applies EXIF orientation and strips source metadata", async () => {
  const input = await source(80, 40).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await validateAvatar(file(input, "image/jpeg"));
  if (!result.ok) throw new Error(result.error);
  const metadata = await sharp(result.bytes).metadata();
  expect(metadata).toMatchObject({ width: 40, height: 80, format: "webp" });
  expect(metadata.orientation).toBeUndefined();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.icc).toBeUndefined();
});

it("ignores source filenames and extensions", async () => {
  const input = await source(16, 8).png().toBuffer();
  const first = await validateAvatar(file(input, "image/png", "../../victim/avatar.jpg"));
  const second = await validateAvatar(file(input, "image/png", "no-extension"));
  expect(first.ok).toBe(true);
  expect(second).toEqual(first);
});

it("rejects zero bytes, unsupported MIME, and MIME spoofing", async () => {
  const png = await source(8, 8).png().toBuffer();
  for (const input of [file(new Uint8Array()), file(png, "image/gif"), file(png, "image/jpeg"),
    file(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'))]) {
    expect(await validateAvatar(input)).toHaveProperty("ok", false);
  }
});

it.each([
  ["image/jpeg", new Uint8Array([255, 216, 255])],
  ["image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
  ["image/webp", new TextEncoder().encode("RIFF0000WEBP")],
])("rejects signature-only malformed %s input", async (mime, bytes) => {
  expect(await validateAvatar(file(bytes, mime))).toMatchObject({ ok: false, error: expect.any(String) });
});

it("rejects corrupted pixels even when metadata can be read", async () => {
  const input = await source(32, 16).png().toBuffer();
  const corrupt = Buffer.from(input);
  corrupt[corrupt.indexOf(Buffer.from("IDAT")) + 4] ^= 0xff;
  expect(await sharp(corrupt).metadata()).toMatchObject({ width: 32, height: 16 });
  expect(await validateAvatar(file(corrupt))).toHaveProperty("ok", false);
});

it("allows exactly 5 MiB but rejects larger input before reading bytes", async () => {
  const input = await source(8, 8).png().toBuffer();
  const padded = new Uint8Array(MAX_AVATAR_SIZE); padded.set(input);
  expect(await validateAvatar(file(padded))).toHaveProperty("ok", true);
  const oversized = file(new Uint8Array(MAX_AVATAR_SIZE + 1));
  oversized.arrayBuffer = () => { throw new Error("Must not read oversized input"); };
  expect(await validateAvatar(oversized)).toEqual({ ok: false, error: "Use an image no larger than 5 MiB." });
});

it.each([[12_001, 1], [1, 12_001], [6500, 6200]])("rejects excessive dimensions %i × %i with a dimension field error", async (width, height) => {
  const input = await source(width, height).png().toBuffer();
  expect(input.length).toBeLessThan(MAX_AVATAR_SIZE);
  expect(await validateAvatar(file(input))).toMatchObject({ ok: false, error: expect.stringContaining("40 million pixels") });
});

it("allows the supported per-side dimension boundary", async () => {
  expect(await validateAvatar(file(await source(12_000, 1).png().toBuffer()))).toHaveProperty("ok", true);
});
