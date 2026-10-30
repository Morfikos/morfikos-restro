import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local-disk file storage for uploaded images.
 *
 * Files are saved under the uploads directory and served by the API at
 * {@link UPLOADS_URL_PREFIX}. Only this module touches the disk, so moving
 * to S3 / Cloudflare R2 later means replacing these functions only.
 */

/** URL prefix uploads are served under (inside /api so the Vite proxy forwards it). */
export const UPLOADS_URL_PREFIX = "/api/v1/uploads/";

/** Largest accepted image upload: 10 MB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** An image type accepted for upload. */
export interface ImageType {
  extension: "jpg" | "png" | "webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
}

/**
 * Returns the directory uploads are stored in: UPLOADS_DIR from the
 * environment, or `apps/api/uploads`.
 *
 * @returns The absolute uploads directory.
 */
export function getUploadsDir(): string {
  return resolve(
    process.env.UPLOADS_DIR ?? fileURLToPath(new URL("../../uploads/", import.meta.url)),
  );
}

/**
 * Creates the uploads directory if it does not exist yet.
 */
export function ensureUploadsDir(): void {
  mkdirSync(getUploadsDir(), { recursive: true });
}

/**
 * Detects an image's type from its first bytes (magic numbers), so a file
 * is never trusted by its name or declared content type alone.
 *
 * @param buffer - The file contents.
 * @returns The image type, or null if it is not a JPEG, PNG or WebP image.
 */
export function detectImageType(buffer: Buffer): ImageType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mimeType: "image/jpeg" };
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { extension: "png", mimeType: "image/png" };
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { extension: "webp", mimeType: "image/webp" };
  }

  return null;
}

/**
 * Resolves an upload URL to its file path, refusing anything outside the
 * uploads directory.
 *
 * @param url - A URL returned by {@link saveUpload}.
 * @returns The absolute file path, or null if the URL is not a local upload.
 */
function resolveUploadPath(url: string): string | null {
  if (!url.startsWith(UPLOADS_URL_PREFIX)) {
    return null;
  }

  const uploadsDir = getUploadsDir();
  const filePath = resolve(uploadsDir, url.slice(UPLOADS_URL_PREFIX.length));

  return filePath.startsWith(uploadsDir + sep) ? filePath : null;
}

/**
 * Saves a file under a folder of the uploads directory with a random name.
 *
 * @param buffer - The file contents.
 * @param folder - The folder, e.g. "floors".
 * @param extension - The file extension without a dot.
 * @returns The public URL of the saved file.
 */
export async function saveUpload(
  buffer: Buffer,
  folder: string,
  extension: string,
): Promise<string> {
  const fileName = `${randomUUID()}.${extension}`;
  const directory = join(getUploadsDir(), folder);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, fileName), buffer);

  return `${UPLOADS_URL_PREFIX}${folder}/${fileName}`;
}

/**
 * Reads a previously saved upload.
 *
 * @param url - The upload's URL.
 * @returns The file contents.
 * @throws Error If the URL is not a local upload or the file is missing.
 */
export async function readUpload(url: string): Promise<Buffer> {
  const filePath = resolveUploadPath(url);

  if (!filePath) {
    throw new Error(`Not a local upload: ${url}`);
  }

  return readFile(filePath);
}

/**
 * Deletes a previously saved upload. Missing files are ignored.
 *
 * @param url - The upload's URL, or null.
 */
export async function deleteUpload(url: string | null): Promise<void> {
  const filePath = url ? resolveUploadPath(url) : null;

  if (!filePath) {
    return;
  }

  await unlink(filePath).catch(() => undefined);
}
