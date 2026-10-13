import 'server-only';
import { createAdminSupabase } from '@/lib/supabase/admin';

export const BRANDING_BUCKET = 'branding';
export const brandingKinds = ['logo', 'letterhead'] as const;
export type BrandingKind = typeof brandingKinds[number];
const limits: Record<BrandingKind, number> = { logo: 1024 * 1024, letterhead: 2 * 1024 * 1024 };
const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' };

/** Sniffs the real file type from its first bytes; the browser-supplied MIME is not trusted. */
function detectType(bytes: Uint8Array): string | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * Stores a logo or letterhead for a tenant at <tenant>/<kind>.<ext>, replacing any previous file.
 * Only PNG and JPEG are accepted (no SVG: it can carry scripts). Returns the object path to save on the workspace.
 */
export async function storeBrandingFile(tenantId: string, kind: BrandingKind, file: File): Promise<{ path: string } | { error: string }> {
  if (file.size > limits[kind]) return { error: `${kind === 'logo' ? 'Logo' : 'Letterhead'} must be under ${limits[kind] / 1024 / 1024} MB.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectType(bytes);
  if (!type) return { error: 'Upload a PNG or JPG image.' };
  const path = `${tenantId}/${kind}.${extensions[type]}`;
  const admin = createAdminSupabase();
  // Remove the other extension so a tenant never has both logo.png and logo.jpg.
  const stale = Object.values(extensions).map(ext => `${tenantId}/${kind}.${ext}`).filter(candidate => candidate !== path);
  await admin.storage.from(BRANDING_BUCKET).remove(stale).catch(() => undefined);
  const { error } = await admin.storage.from(BRANDING_BUCKET).upload(path, bytes, { contentType: type, upsert: true, cacheControl: '60' });
  if (error) return { error: 'The file could not be stored. Try again.' };
  return { path };
}

export async function removeBrandingFile(path: string) {
  await createAdminSupabase().storage.from(BRANDING_BUCKET).remove([path]);
}

/** Short-lived URL for a tenant's own file; the caller has already verified membership. */
export async function signedBrandingUrl(path: string, seconds = 600): Promise<string | null> {
  const { data } = await createAdminSupabase().storage.from(BRANDING_BUCKET).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}
