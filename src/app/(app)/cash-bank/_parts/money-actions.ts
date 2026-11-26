"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { cancelMoneyInOut, recordMoneyInOut } from "@/modules/money-in-out/commands";
import type { Direction } from "@/modules/money-in-out/rules";

// Money in and money out (batch A). The company always comes from the verified session, never
// from the form; the direction and ids arrive bound to the action and are checked again in the command.

async function requireCashBankModule() {
  const session = await requireTenant();
  if (!session.modules.cash_bank) throw new UserError("Cash and bank is switched off for this company.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

export async function moneyInOutAction(direction: Direction, _: FormState, formData: FormData): Promise<FormState> {
  let number: string;
  try {
    const session = await requireCashBankModule();
    ({ number } = await recordMoneyInOut(session, {
      direction,
      date: formData.get("date"),
      moneyAccountId: formData.get("moneyAccountId"),
      otherAccountId: formData.get("otherAccountId"),
      amount: formData.get("amount"),
      party: formData.get("party"),
      reference: formData.get("reference"),
      memo: formData.get("memo"),
      clientKey: formData.get("clientKey"),
    }));
  } catch (error) {
    return refusal(`record money ${direction}`, error);
  }
  refresh();
  return { ok: true, message: `Recorded as ${number}.` };
}

export async function cancelMoneyInOutAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireCashBankModule();
    await cancelMoneyInOut(session, id, { date: formData.get("date"), reason: formData.get("reason") });
  } catch (error) {
    return refusal("cancel money in or out", error);
  }
  refresh();
  return { ok: true, message: "Cancelled." };
}
