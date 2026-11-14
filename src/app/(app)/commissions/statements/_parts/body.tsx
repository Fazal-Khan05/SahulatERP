import type Decimal from "decimal.js";
import Link from "next/link";
import { formatAmount } from "@/lib/money";
import type { CommissionStatementData } from "@/modules/commission-statements/queries";
import { owedToThem, waitingForCustomers } from "@/modules/commission-statements/rules";
import { formatIsoDate } from "@/modules/currencies/rules";

const cell = (amount: Decimal) => (amount.isZero() ? "" : formatAmount(amount));
const money = "py-1.5 pr-3 text-right whitespace-nowrap tabular-nums";

/**
 * A commission statement's table and its figures at the end, for the screen and the printed
 * page alike. `linkInvoices` links each invoice to its page, for a reader who may open it.
 */
export function CommissionStatementBody({ data, linkInvoices = false }: { data: CommissionStatementData; linkInvoices?: boolean }) {
  const { statement } = data;
  const owed = owedToThem(statement.closing);
  return (
    <>
      <div className="overflow-x-auto">
        <table aria-label="Commission statement" className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b-2 border-foreground">
            <tr>
              <th className="py-1.5 pr-3 font-semibold">Date</th>
              <th className="py-1.5 pr-3 font-semibold">Number</th>
              <th className="py-1.5 pr-3 font-semibold">What</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Earned</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Released</th>
              <th className="py-1.5 pr-3 text-right font-semibold">Paid</th>
              <th className="py-1.5 text-right font-semibold">Owed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            <tr>
              <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(data.from)}</td>
              <td className="py-1.5 pr-3" colSpan={5}>
                Brought forward
              </td>
              <td className="py-1.5 text-right whitespace-nowrap tabular-nums" data-testid="commission-statement-opening">
                {formatAmount(owedToThem(statement.opening))}
              </td>
            </tr>
            {statement.lines.map((line, index) => (
              <tr key={index} className="break-inside-avoid">
                <td className="py-1.5 pr-3 whitespace-nowrap">{formatIsoDate(line.date)}</td>
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {linkInvoices && line.invoiceId && line.number ? (
                    <Link href={`/sales/${line.invoiceId}`} className="underline-offset-4 hover:underline">
                      {line.number}
                    </Link>
                  ) : (
                    (line.number ?? "")
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {line.what}
                  {line.customerName || line.teamMember ? (
                    <span className="block text-xs text-muted-foreground">{[line.customerName, line.teamMember ? `sold by ${line.teamMember}` : null].filter(Boolean).join(", ")}</span>
                  ) : null}
                </td>
                <td className={money}>{cell(line.earned)}</td>
                <td className={money}>{cell(line.released)}</td>
                <td className={money}>{cell(line.paid)}</td>
                <td className="py-1.5 text-right whitespace-nowrap tabular-nums">{formatAmount(line.balance)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-foreground font-bold">
            <tr>
              <td className="py-1.5 pr-3" colSpan={3}>
                For the period
              </td>
              <td className={money} data-testid="commission-statement-earned">
                {formatAmount(statement.period.earned)}
              </td>
              <td className={money} data-testid="commission-statement-released">
                {formatAmount(statement.period.released)}
              </td>
              <td className={money} data-testid="commission-statement-paid">
                {formatAmount(statement.period.paid)}
              </td>
              <td className="py-1.5 text-right whitespace-nowrap tabular-nums" data-testid="commission-statement-closing">
                {formatAmount(owed)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {statement.lines.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">Nothing happened to this commission in the period.</p> : null}
      <dl className="mt-6 ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm" data-testid="commission-statement-summary">
        <dt className="col-span-2 font-bold">On {formatIsoDate(data.to)}</dt>
        <dt>Earned in all</dt>
        <dd className="text-right tabular-nums">{formatAmount(statement.closing.earned)}</dd>
        <dt>Waiting for customers to pay</dt>
        <dd className="text-right tabular-nums">{formatAmount(waitingForCustomers(statement.closing))}</dd>
        <dt>Released by customers&apos; payments</dt>
        <dd className="text-right tabular-nums">{formatAmount(statement.closing.released)}</dd>
        <dt>Paid</dt>
        <dd className="text-right tabular-nums">{formatAmount(statement.closing.paid)}</dd>
        <dt className="font-bold">{owed.isNegative() ? "Owed back, from the next payment" : "Owed, to be paid"}</dt>
        <dd className="text-right font-bold tabular-nums">{formatAmount(owed.abs())}</dd>
      </dl>
      <p className="mt-4 text-xs text-muted-foreground">
        Commission is earned when an invoice is posted, released as the customer pays (a cheque when it clears), and taken back when goods are returned or a payment is undone. Released commission is paid once the owner
        or an accountant approves it. Owed below nothing is commission paid that has since been taken back.
      </p>
    </>
  );
}
