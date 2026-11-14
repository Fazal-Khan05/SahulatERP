"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { deletePlan, savePlan, setManager } from "@/modules/commissions/commands";

// Step 37: commission plans and the sales hierarchy. The company comes from the verified session;
// ids arrive bound to the action and are checked again by the command and the database.

async function requireCommissions() {
  const session = await requireTenant();
  if (!session.modules.commissions) throw new UserError("Commissions is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

const pairs = <K extends string, V extends string>(formData: FormData, key: K, value: V) => {
  const keys = formData.getAll(key);
  const values = formData.getAll(value);
  return keys.map((k, at) => ({ [key]: k, [value]: values[at] }) as Record<K | V, FormDataEntryValue | undefined>);
};

export async function savePlanAction(id: string | null, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCommissions();
    await savePlan(session, id, {
      name: formData.get("name"),
      userId: formData.get("userId"),
      kind: formData.get("kind"),
      rate: formData.get("rate"),
      target: formData.get("target"),
      multiplier: formData.get("multiplier"),
      teamRate: formData.get("teamRate"),
      from: formData.get("from"),
      to: formData.get("to"),
      categoryRates: pairs(formData, "categoryId", "categoryRate").map((row) => ({ categoryId: row.categoryId, rate: row.categoryRate })),
      classRates: pairs(formData, "customerClass", "classRate").map((row) => ({ customerClass: row.customerClass, rate: row.classRate })),
      tiers: pairs(formData, "tierFrom", "tierRate").map((row) => ({ threshold: row.tierFrom, rate: row.tierRate })),
    });
    return { location: "/commissions" };
  } catch (error) {
    return refusal("save commission plan", error);
  }
}

export async function deletePlanAction(id: string): Promise<FormState> {
  try {
    const session = await requireCommissions();
    await deletePlan(session, id);
    return { location: "/commissions" };
  } catch (error) {
    return refusal("delete commission plan", error);
  }
}

export async function setManagerAction(userId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCommissions();
    const manager = formData.get("managerUserId");
    await setManager(session, userId, typeof manager === "string" && manager !== "" ? manager : null);
    refresh();
    return { ok: true, message: "Saved." };
  } catch (error) {
    return refusal("set manager", error);
  }
}
