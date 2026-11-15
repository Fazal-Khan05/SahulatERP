"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import type { FormState } from "@/lib/form-state";
import { importAttendance, saveEmployee, setPay, setStatutoryRate } from "@/modules/payroll/commands";
import type { AttendanceProblem } from "@/modules/payroll/rules";

// Step 40. The company always comes from the verified session, never from the form; ids arrive
// bound to the action and are checked again in the command.

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

const employeeForm = (formData: FormData) => ({
  code: formData.get("code"),
  name: formData.get("name"),
  designation: formData.get("designation"),
  cnic: formData.get("cnic"),
  province: formData.get("province"),
  branchId: formData.get("branchId"),
  payBasis: formData.get("payBasis"),
  joinedOn: formData.get("joinedOn"),
  leftOn: formData.get("leftOn"),
  eobi: formData.get("eobi"),
  socialSecurity: formData.get("socialSecurity"),
  userId: formData.get("userId"),
});

/** Adds an employee and opens them, or saves the changes to one. */
export async function saveEmployeeAction(id: string | null, loadedAt: string, _: FormState, formData: FormData): Promise<FormState> {
  let saved: { id: string };
  try {
    const session = await requirePayrollModule();
    saved = await saveEmployee(session, id, employeeForm(formData), loadedAt);
  } catch (error) {
    return refusal("save employee", error);
  }
  if (id === null) return { location: `/payroll/employees/${saved.id}` };
  refresh();
  return { message: "Saved." };
}

export async function setPayAction(employeeId: string, _: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requirePayrollModule();
    await setPay(session, employeeId, { component: formData.get("component"), amount: formData.get("amount"), effectiveFrom: formData.get("effectiveFrom") });
  } catch (error) {
    return refusal("set pay", error);
  }
  refresh();
  return { ok: true, message: "Pay saved." };
}

export type AttendanceImportState = FormState & { imported?: number; problems?: AttendanceProblem[] };

/** Imports a month's attendance file, all or nothing. Bad rows come back to be shown; nothing is kept. */
export async function importAttendanceAction(month: string, _: AttendanceImportState, formData: FormData): Promise<AttendanceImportState> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > 800 * 1024) return { error: "The file is too large. Import at most 2,000 rows at a time." };
  try {
    const session = await requirePayrollModule();
    const outcome = await importAttendance(session, month, { name: file.name, text: await file.text() });
    if ("problems" in outcome) return { problems: outcome.problems };
    refresh();
    return { ok: true, imported: outcome.imported };
  } catch (error) {
    return refusal("import attendance", error);
  }
}

export async function setStatutoryRateAction(_: FormState, formData: FormData): Promise<FormState> {
  try {
    const session = await requireTenant();
    await setStatutoryRate(session, {
      kind: formData.get("kind"),
      province: formData.get("province"),
      effectiveFrom: formData.get("effectiveFrom"),
      rate: formData.get("rate"),
      amount: formData.get("amount"),
      legalReference: formData.get("legalReference"),
    });
  } catch (error) {
    return refusal("set statutory rate", error);
  }
  refresh();
  return { ok: true, message: "Saved." };
}
