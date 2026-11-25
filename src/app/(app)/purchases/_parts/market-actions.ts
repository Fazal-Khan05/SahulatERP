"use server";

import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { postMarketPurchase } from "@/modules/market-purchases/commands";
import { backToSales } from "@/modules/market-purchases/rules";

// The company always comes from the verified session, never from the form.

/** One list of a form's repeated field, as text. */
const column = (formData: FormData, name: string) => formData.getAll(name).map((value) => (typeof value === "string" ? value : ""));

/**
 * Records a quick market purchase: the order, the goods received, the bill and the payment, all
 * or none. `back` is the delivery note or invoice it was opened from, if any: the buyer returns
 * there, with the goods now in stock.
 */
export async function marketPurchaseAction(back: string | null, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireTenant();
    if (!session.modules.purchasing) throw new UserError("Purchasing is switched off for this company.");
    const itemIds = column(formData, "itemId");
    const unitIds = column(formData, "unitId");
    const quantities = column(formData, "quantity");
    const costs = column(formData, "unitCost");
    const made = await postMarketPurchase(session, {
      date: formData.get("date"),
      warehouseId: formData.get("warehouseId"),
      sellerKind: formData.get("sellerKind"),
      supplierId: formData.get("supplierId"),
      sellerName: formData.get("sellerName"),
      sellerPhone: formData.get("sellerPhone"),
      memoNo: formData.get("memoNo"),
      note: formData.get("note"),
      lines: itemIds.map((itemId, index) => ({ itemId, unitId: unitIds[index], quantity: quantities[index], unitCost: costs[index] })),
      method: formData.get("method"),
      accountId: formData.get("accountId"),
      reference: formData.get("reference"),
      clientKey: formData.get("clientKey"),
    });
    const returnTo = backToSales(back);
    return { location: returnTo ? `${returnTo}?bought=${made.id}` : `/purchases/bills/${made.billId}` };
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure("record quick market purchase", error);
    return { error: "That did not work. Please try again." };
  }
}
