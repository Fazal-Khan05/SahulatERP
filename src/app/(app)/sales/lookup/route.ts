import type { NextRequest } from "next/server";
import { getSessionUser, getTenantSession } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { AMOUNT_SCALE } from "@/lib/money";
import { getCustomerCredit, getLineDefaults, searchCustomers, searchItems } from "@/modules/sales/queries";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" } });

// What the sales form looks up as it is typed: customers and items by part of their code or
// name, what a line starts from once its item is chosen, and how a customer stands against its
// credit limit. Read-only, and for the signed-in member's own company only: nothing in the
// address says which company.
export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  const session = user ? await getTenantSession() : null;
  if (!session || !session.modules.sales) return json(404, { error: "Not found" });
  const query = request.nextUrl.searchParams;
  const typed = (query.get("q") ?? "").slice(0, 80);
  try {
    switch (query.get("what")) {
      case "customers":
        return json(200, { choices: await searchCustomers(session, typed) });
      case "items":
        return json(200, { choices: await searchItems(session, typed) });
      case "line":
        return json(200, { line: await getLineDefaults(session, { itemId: query.get("item") ?? "", customerId: query.get("customer") || null, date: query.get("date") ?? "" }) });
      case "credit": {
        const credit = await getCustomerCredit(session, query.get("customer") ?? "", query.get("except") || null);
        return json(200, { credit: credit === null ? null : { limit: credit.limit?.toFixed(AMOUNT_SCALE) ?? null, receivable: credit.receivable.toFixed(AMOUNT_SCALE), openOrders: credit.openOrders.toFixed(AMOUNT_SCALE) } });
      }
      default:
        return json(404, { error: "Not found" });
    }
  } catch (error) {
    if (error instanceof UserError) return json(404, { error: "Not found" });
    logFailure("sales lookup", error);
    return json(500, { error: "That did not work. Please try again." });
  }
}
