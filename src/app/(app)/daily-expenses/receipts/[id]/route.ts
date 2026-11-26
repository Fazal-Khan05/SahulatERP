import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { objectStore } from "@/lib/storage";
import { getReceiptFile } from "@/modules/daily-expenses/queries";

const LINK_SECONDS = 60;
const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

// Opens the receipt of an expense: checks that this person may see the expense, then sends the
// browser to a link from the object store that works for one minute. A receipt of another
// company, or of an expense this person may not see, is simply not found.
export async function GET(_: Request, { params }: RouteContext<"/daily-expenses/receipts/[id]">) {
  const { id } = await params;
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.cash_bank) return notFound();

  try {
    const file = await getReceiptFile(session, id);
    if (!file) return notFound();
    const store = await objectStore();
    const url = await store.signedDownloadUrl(file.storageKey, { filename: file.name, expiresInSeconds: LINK_SECONDS });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserError) return notFound();
    logFailure("open receipt", error);
    return new Response("The receipt could not be fetched. Try again.", { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
