"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { createPriceList, setClassPrice, setCustomerPrice, setDefaultPriceList, setListPrice } from "@/modules/prices/commands";

// The company always comes from the verified session, never from the form. Ids arrive bound to
// the action and are checked again in the command. Prices belong to Sales: off means closed.

async function run(context: string, work: (session: Awaited<ReturnType<typeof requireTenant>>) => Promise<void>, done: FormState): Promise<FormState> {
  const session = await requireTenant();
  if (!session.modules.sales) return { error: "Sales is switched off for this company." };
  try {
    await work(session);
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    logFailure(context, error);
    return { error: "That did not work. Please try again." };
  }
  refresh();
  return done;
}

const price = (formData: FormData) => ({ item: formData.get("item"), price: formData.get("price"), validFrom: formData.get("validFrom"), validTo: formData.get("validTo") });

export async function createPriceListAction(_: FormState, formData: FormData): Promise<FormState> {
  return run("create price list", async (session) => void (await createPriceList(session, formData.get("name"))), { ok: true, message: "Added." });
}

export async function setDefaultPriceListAction(listId: string): Promise<FormState> {
  return run("set default price list", (session) => setDefaultPriceList(session, listId), {});
}

export async function setListPriceAction(listId: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("set list price", (session) => setListPrice(session, listId, price(formData)), { ok: true, message: "Saved." });
}

/** `itemId` is bound when the form sits on an item's own screen. */
export async function setClassPriceAction(itemId: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("set class price", (session) => setClassPrice(session, { ...price(formData), item: itemId, customerClass: formData.get("customerClass") }), { ok: true, message: "Saved." });
}

export async function setCustomerPriceAction(itemId: string, _: FormState, formData: FormData): Promise<FormState> {
  return run("set customer price", (session) => setCustomerPrice(session, { ...price(formData), item: itemId, customer: formData.get("customer") }), { ok: true, message: "Saved." });
}
