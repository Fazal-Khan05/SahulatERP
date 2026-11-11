import "server-only";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Where file bytes are kept. Supabase Storage today, Cloudflare R2 later: everything that stores
 * or serves a file goes through these two methods, so the move is a change in this folder only.
 */
export interface ObjectStore {
  /** Stores the bytes under the key. Fails if the key is already taken. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** A link that downloads the file and stops working after the given time. */
  signedDownloadUrl(key: string, options: { filename: string; expiresInSeconds: number }): Promise<string>;
}

const BUCKET = "files";

/**
 * The object store, acting as the signed-in user. Supabase Storage applies its own row-level
 * security to every call: the first part of the key is a company id, and the policies check that
 * the user is an owner (to store) or an owner or auditor (to read) of that company.
 */
export async function objectStore(): Promise<ObjectStore> {
  const supabase = await createSupabaseServerClient();
  const bucket = supabase.storage.from(BUCKET);
  return {
    async put(key, bytes, contentType) {
      const { error } = await bucket.upload(key, bytes, { contentType, upsert: false });
      if (error) throw new Error(`object store refused the upload: ${error.message}`);
    },
    async signedDownloadUrl(key, { filename, expiresInSeconds }) {
      const { data, error } = await bucket.createSignedUrl(key, expiresInSeconds);
      if (error || !data?.signedUrl) throw new Error(`object store refused to sign: ${error?.message ?? "no link"}`);
      // The client library encodes a download name twice, which mangles any name that is not
      // plain English letters. Adding it here encodes it once.
      const link = new URL(data.signedUrl);
      link.searchParams.set("download", filename);
      return link.href;
    },
  };
}
