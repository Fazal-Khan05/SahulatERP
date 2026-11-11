import { z } from "zod";

// Pure rules for stored files. No I/O.
//
// The files table holds where a file is, never its bytes; the bytes live in the object store
// under a key made from the company's id and the file's id.

export const FILE_STATUSES = ["pending", "stored"] as const;
export type FileStatus = (typeof FILE_STATUSES)[number];

/** A little under what one request to the app can carry. Larger files need a direct upload. */
export const FILE_MAX_BYTES = 4 * 1024 * 1024;

export const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const;
export type FileType = (typeof FILE_TYPES)[number];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/** What a file actually is, read from its first bytes; null for anything not accepted. */
export function sniffFileType(bytes: Uint8Array): FileType | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

/** Accepts a file by its contents and size, never by its name or the type the browser claims. */
export function checkFile(bytes: Uint8Array): { ok: true; contentType: FileType } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: "Choose a file." };
  if (bytes.length > FILE_MAX_BYTES) return { ok: false, reason: "The file must be 4 MB or smaller." };
  const contentType = sniffFileType(bytes);
  return contentType ? { ok: true, contentType } : { ok: false, reason: "Use a PDF, PNG, JPEG or WebP file." };
}

// The name is only ever shown and offered as the download name. Folders and control characters
// are dropped so it can never be read as a path.
export const fileNameSchema = z
  .string()
  .transform((name) =>
    (name.split(/[\\/]/).pop() ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 200),
  )
  .pipe(z.string().min(1, "The file needs a name."));

/** Where a file's bytes live in the object store. */
export function storageKey(tenantId: string, fileId: string): string {
  return `${tenantId}/${fileId}`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
