import sharp from "sharp";
import { expect, it } from "vitest";
import { MAX_AVATAR_SIZE, validateAvatar } from "../../../src/lib/profile/avatar-validation";

const source = (width = 1024, height = 512) => sharp({ create: { width, height, channels: 3, background: "red" } });
const file = (bytes: Uint8Array, type = "image/png", name = "untrusted.exe") => new File([new Uint8Array(bytes)], name, { type });

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

it.each([
  ["image/jpeg", new Uint8Array([255, 216, 255])],
  ["image/png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
  ["image/webp", new TextEncoder().encode("RIFF0000WEBP")],
])("rejects signature-only malformed %s input", async (mime, bytes) => {
  expect(await validateAvatar(file(bytes, mime))).toMatchObject({ ok: false, error: expect.any(String) });
});

it("allows exactly 5 MiB but rejects larger input before reading bytes", async () => {
  const input = await source(8, 8).png().toBuffer();
  const padded = new Uint8Array(MAX_AVATAR_SIZE); padded.set(input);
  expect(await validateAvatar(file(padded))).toHaveProperty("ok", true);
  const oversized = file(new Uint8Array(MAX_AVATAR_SIZE + 1));
  oversized.arrayBuffer = () => { throw new Error("Must not read oversized input"); };
  expect(await validateAvatar(oversized)).toEqual({ ok: false, error: "Use an image no larger than 5 MiB." });
});

it.each([[6500, 6200]])("rejects excessive dimensions %i × %i with a dimension field error", async (width, height) => {
  const input = await source(width, height).png().toBuffer();
  expect(input.length).toBeLessThan(MAX_AVATAR_SIZE);
  expect(await validateAvatar(file(input))).toMatchObject({ ok: false, error: expect.stringContaining("40 million pixels") });
});
