import Decimal from "decimal.js";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listCustomerAgeing, listRecoveryMarks } from "@/modules/recovery/queries";
import { overdueCustomers } from "@/modules/recovery/rules";
import { Refused, Sections, recoveryRefusal } from "../_parts/parts";

export const metadata: Metadata = { title: "Overdue customers" };

export default function OverduePage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <Overdue />
    </Suspense>
  );
}

// Customers with anything past its due date, most overdue first. Built from the same rows as the
// aged receivables report, so the two always agree.
async function Overdue() {
  const session = await requireTenant();
  const refused = recoveryRefusal(session);
  if (refused) return <Refused title="Overdue customers" reason={refused} />;
  const today = todayIso(new Date());
  const [aged, marks] = await Promise.all([listCustomerAgeing(session, today), listRecoveryMarks(session, today)]);
  const overdue = overdueCustomers(aged);
  const total = overdue.reduce((sum, row) => sum.plus(row.overdue), new Decimal(0));
  return (
    <>
      <PageHead title="Overdue customers" sub="Customers with money past its due date, most overdue first." />
      <Sections session={session} current="/recovery/overdue" />
      <Card className="max-w-5xl">
        {overdue.length === 0 ? (
          <Empty>No customer owes anything past its due date.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Overdue customers" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 text-right font-medium">Overdue</th>
                  <th className="py-2 pr-4 text-right font-medium">Oldest, days late</th>
                  <th className="py-2 pr-4 text-right font-medium">Not due yet</th>
                  <th className="py-2 pr-4 font-medium">Next follow-up</th>
                  <th className="py-2 font-medium">Promises</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {overdue.map((row) => {
                  const mark = marks.get(row.customerId);
                  return (
                    <tr key={row.customerId}>
                      <td className="py-2 pr-4">
                        <Link href={`/recovery/customers/${row.customerId}`} className="font-medium underline-offset-4 hover:underline">
                          {row.name}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums" data-testid="overdue-amount">
                        {formatAmount(row.overdue)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.oldestDays}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{row.bands[0].isZero() ? "" : formatAmount(row.bands[0])}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{mark?.nextOn ? formatIsoDate(mark.nextOn) : ""}</td>
                      <td className="py-2 whitespace-nowrap">{mark?.brokenPromises ? <span className="text-destructive">{mark.brokenPromises} broken</span> : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t font-bold">
                <tr>
                  <td className="py-2 pr-4">Total overdue</td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums" data-testid="overdue-total">
                    {formatAmount(total)}
                  </td>
                  <td colSpan={4} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
