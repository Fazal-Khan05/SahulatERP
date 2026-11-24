"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { approveRun, cancelRun, payRun, reviewRun, workOutRun } from "@/modules/payroll-runs/commands";

// Step 41. The company always comes from the verified session, never from the form; a run's id
// arrives bound to the action and is checked again in the command and by the database.

async function requirePayrollModule() {
  const session = await requireTenant();
  if (!session.modules.payroll) throw new UserError("Payroll is switched off for this company. An owner switches it on under Settings, Modules.");
  return session;
}

function refusal(context: string, error: unknown): FormState {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

/** Works a month out, or again, and opens the run. Who cannot be paid, and why, comes back instead. */
export async function workOutRunAction(_: FormState, formData: FormData): Promise<FormState> {
  const typed = formData.get("month");
  let id: string;
  try {
    const session = await requirePayrollModule();
    const outcome = await workOutRun(session, typeof typed === "string" && /^\d{4}-\d{2}$/.test(typed) ? `${typed}-01` : typed);
    if ("problems" in outcome) {
      const list = outcome.problems.map((p) => `${p.code} ${p.name} ${p.reason}`).join(" ");
      return { error: `Nothing was worked out. ${outcome.problems.length === 1 ? "One person needs" : `${outcome.problems.length} people need`} putting right first: ${list}` };
    }
    id = outcome.id;
  } catch (error) {
    return refusal("work out payroll run", error);
  }
  return { location: `/payroll/runs/${id}` };
}

export async function reviewRunAction(id: string): Promise<FormState> {
  try {
    await reviewRun(await requirePayrollModule(), id);
  } catch (error) {
    return refusal("review payroll run", error);
  }
  refresh();
  return { ok: true, message: "Reviewed. The owner or an accountant approves it next." };
}

export async function approveRunAction(id: string): Promise<FormState> {
  let number: string;
  try {
    ({ number } = await approveRun(await requirePayrollModule(), id));
  } catch (error) {
    return refusal("approve payroll run", error);
  }
  refresh();
  return { ok: true, message: `Approved as ${number}, and in the books.` };
}

export async function payRunAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    await payRun(await requirePayrollModule(), id, { date: formData.get("date"), accountId: formData.get("accountId") });
  } catch (error) {
    return refusal("pay payroll run", error);
  }
  refresh();
  return { ok: true, message: "Paid." };
}

export async function cancelRunAction(id: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    await cancelRun(await requirePayrollModule(), id, formData.get("reason"));
  } catch (error) {
    return refusal("cancel payroll run", error);
  }
  refresh();
  return { ok: true, message: "Cancelled." };
}
