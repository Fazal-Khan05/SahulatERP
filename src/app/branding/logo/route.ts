import type { NextRequest } from "next/server";
import { isUuid } from "@/db";
import { getSessionUser } from "@/lib/auth/session";
import { getLogo } from "@/modules/tenant/queries";

// A company's logo: /branding/logo?t=<company>&v=<version>. Served only to a signed-in member of
// that company. When the version in the address is the current one the browser may keep the
// image for good; an address left over from before the logo changed gets the current image but
// is told not to keep it, so an old address can never hold a newer picture.
export async function GET(request: NextRequest) {
  const tenantId = request.nextUrl.searchParams.get("t");
  const version = request.nextUrl.searchParams.get("v");
  const user = await getSessionUser();
  const logo = user && isUuid(tenantId) ? await getLogo(user.id, tenantId) : null;
  if (!logo) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });

  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "Content-Type": logo.contentType,
      "Content-Length": String(logo.bytes.byteLength),
      "Cache-Control": version === String(logo.version) ? "private, max-age=31536000, immutable" : "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
