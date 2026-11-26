import "server-only";
import { sql } from "drizzle-orm";
import { isUuid, withTenant } from "@/db";
import { UserError, pgCode } from "@/lib/errors";
import { todayIso } from "@/lib/format";
import { paymentRefusal, recordChallan } from "@/modules/supplier-payments/commands";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { readTaxChallan, type RawTaxChallan } from "./rules";

// Records a challan. One that pays only tax withheld on supplier bills is Step 26's, recorded
// as it always was. One that also pays tax withheld on an expense, or the income tax a payroll
// run deducted from pay, is recorded by app.record_tax_challan (drizzle, "tax paid over"): the
// same document in every way, with its number, its journal and its audit rows, in one act.

const uuids = (list: readonly string[]) => `{${list.join(",")}}`;

export async function recordTaxChallan(ctx: TenantContext, raw: RawTaxChallan): Promise<{ number: string }> {
  if (!can(ctx.role, "supplier_payment.manage")) throw new UserError("Only an owner or an accountant can record a challan.");
  if (ctx.branchIds !== null) throw new UserError("A challan is for the whole company: only someone who works in every branch can record one.");
  const read = readTaxChallan(raw);
  if (!read.ok) throw new UserError(read.reason);
  const challan = read.challan;
  // Nothing but bills' entries ticked: the challan of Step 26, by its own command.
  if (challan.expenseEntryIds.length === 0 && challan.runIds.length === 0) return recordChallan(ctx, { ...raw, entryIds: challan.entryIds });
  if (challan.paidOn > todayIso(new Date())) throw new UserError("That date has not come yet.");
  if (!isUuid(challan.accountId)) throw new UserError("Choose the cash or bank account from the list.");
  for (const id of [...challan.entryIds, ...challan.expenseEntryIds, ...challan.runIds]) if (!isUuid(id)) throw new UserError("Tick the amounts from the list.");
  try {
    return await withTenant(ctx.userId, ctx.tenantId, async (tx) => {
      const [row] = await tx.execute<{ number: string }>(sql`
        select app.record_tax_challan(${challan.kind}, ${challan.paidOn}::date, ${challan.accountId}::uuid, ${challan.challanNo},
          ${uuids(challan.entryIds)}::uuid[], ${uuids(challan.expenseEntryIds)}::uuid[], ${uuids(challan.runIds)}::uuid[], ${challan.note}) as number`);
      return { number: row.number };
    });
  } catch (error) {
    const code = pgCode(error);
    if (code === "SE379") {
      throw new UserError("A challan pays whole amounts of its own kind of tax, withheld or deducted on or before its date, each once. Another challan may have paid one of them since you opened this page, or an expense among them was cancelled: reload and tick again.");
    }
    if (code === "SE333") throw new UserError("That date has not come yet.");
    if (code === "42501") throw new UserError("Only an owner or an accountant who works in every branch can record a challan.");
    throw paymentRefusal(error, challan.paidOn) ?? error;
  }
}
