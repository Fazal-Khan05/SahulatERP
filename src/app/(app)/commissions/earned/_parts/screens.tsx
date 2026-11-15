import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { getEarned, listPayments, type Accrual } from "@/modules/commission-ledger/queries";
import { owedBack, paidLine, payable, paymentOf, standingLabel, totalsOf } from "@/modules/commission-ledger/rules";
import { formatIsoDate } from "@/modules/currencies/rules";
import { listMoneyAccounts } from "@/modules/receipts/queries";
import { can } from "@/modules/tenant/rules";
import { approveCommissionAction, payCommissionAction } from "./actions";

const SELECT = "h-8 min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const money = "py-2 pr-4 text-right whitespace-nowrap tabular-nums";

/** What an accrual is for, in words: the earner's own sale, or a manager's share of someone else's. */
const what = (row: Accrual, names: Record<string, string>) => (row.kind === "own" ? (row.sharePercent.eq(100) ? "Own sale" : `Own sale, ${row.sharePercent.toFixed()}% of the line`) : `${row.teamRate?.toFixed() ?? ""}% of ${names[row.sellerUserId] ?? "a team member"}'s sale`);

/**
 * What the sales team has earned in commission and what has become of it. The owner, an
 * accountant and the auditor see everyone and open one person; a salesperson or a manager sees
 * their own. The owner and an accountant approve what the customers' payments have released,
 * and pay it.
 */
export async function EarnedScreen({ searchParams }: { searchParams: Promise<{ person?: string | string[]; paid?: string | string[] }> }) {
  const session = await requireTenant();
  const everyone = can(session.role, "commission_earned.read");
  const own = can(session.role, "commission_earned.own");
  if (!session.modules.commissions || (!everyone && !own)) {
    return (
      <>
        <PageHead title="Commission earned" />
        <p className="text-muted-foreground">{session.modules.commissions ? "Your role does not include commission." : "Commissions is switched off for this company."}</p>
      </>
    );
  }
  const query = await searchParams;
  const asked = typeof query.person === "string" ? query.person : null;
  // Someone who does not read everyone's sees their own, and their team's when they have one:
  // row-level security decides which people come back at all.
  const person = everyone ? asked : (asked ?? session.userId);
  const approver = can(session.role, "commission.approve");
  const payer = can(session.role, "commission.pay") && session.branchIds === null;
  const [earned, payments, accounts] = await Promise.all([getEarned(session, person), listPayments(session), payer && person ? listMoneyAccounts(session) : []]);
  const team = everyone || earned.people.some((p) => p.userId !== session.userId);
  const chosen = person ? earned.people.find((p) => p.userId === person) : undefined;
  const rows = person ? earned.accruals : [];
  const totals = totalsOf(rows);
  const toApprove = rows.filter((row) => payable(row).gt(0) && !row.approved);
  const due = paymentOf(totals.approved, totals.owedBack);
  // The payment just made, when the page was loaded again after paying: one of this person's own.
  const justPaid = typeof query.paid === "string" && person ? payments.find((payment) => payment.id === query.paid && payment.userId === person) : undefined;

  return (
    <>
      <PageHead
        title={everyone ? "Commission earned" : team ? "My commission and my team's" : "My commission"}
        sub="Commission is earned when an invoice is posted, released as the customer pays (a cheque when it clears), and taken back when goods are returned or a cheque bounces."
      />
      <div className="flex max-w-6xl flex-col gap-5">
        {team ? (
          <Card title={everyone ? "The sales team" : "My team and I"}>
            {earned.people.length === 0 ? (
              <Empty>Nobody has earned commission yet. It is earned when an invoice with a salesperson on it is posted, on the plan that applies that day.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="Commission by person" className="w-full min-w-[760px] text-left text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Person</th>
                      <th className="py-2 pr-4 text-right font-medium">Earned</th>
                      <th className="py-2 pr-4 text-right font-medium">Waiting for customers</th>
                      <th className="py-2 pr-4 text-right font-medium">Released, to pay</th>
                      <th className="py-2 pr-4 text-right font-medium">Of which approved</th>
                      <th className="py-2 pr-4 text-right font-medium">Paid</th>
                      <th className="py-2 text-right font-medium">Owed back</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {earned.people.map((p) => (
                      <tr key={p.userId} aria-current={p.userId === person ? "true" : undefined} className={p.userId === person ? "bg-accent/40" : undefined}>
                        <td className="py-2 pr-4 font-medium">
                          <Link href={`/commissions/earned?person=${p.userId}`} className="underline-offset-4 hover:underline">
                            {p.name}
                          </Link>
                        </td>
                        <td className={money}>{formatAmount(p.totals.earned)}</td>
                        <td className={money}>{formatAmount(p.totals.waiting)}</td>
                        <td className={money}>{formatAmount(p.totals.payable)}</td>
                        <td className={money}>{formatAmount(p.totals.approved)}</td>
                        <td className={money}>{formatAmount(p.totals.paid)}</td>
                        <td className="py-2 text-right whitespace-nowrap tabular-nums">{p.totals.owedBack.isZero() ? "" : formatAmount(p.totals.owedBack)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!person && earned.people.length > 0 ? <p className="mt-3 text-sm text-muted-foreground">Choose a person to see what it is made of, and to approve and pay it.</p> : null}
          </Card>
        ) : null}

        {person ? (
          <Card title={person === session.userId ? "What I have earned" : `What ${chosen?.name ?? "this person"} has earned`}>
            {rows.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <ActionForm action={approveCommissionAction} submitLabel="Approve the ticked for payment" className={approver && toApprove.length > 0 ? undefined : "[&_button[type=submit]]:hidden"}>
                <dl className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4" data-testid="commission-totals">
                  <div>
                    <dt className="text-muted-foreground">Earned</dt>
                    <dd className="font-semibold tabular-nums">{formatAmount(totals.earned)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Released, to pay</dt>
                    <dd className="font-semibold tabular-nums">{formatAmount(totals.payable)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Paid</dt>
                    <dd className="font-semibold tabular-nums">{formatAmount(totals.paid)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Owed back</dt>
                    <dd className="font-semibold tabular-nums">{formatAmount(totals.owedBack)}</dd>
                  </div>
                </dl>
                <div className="overflow-x-auto">
                  <table aria-label="Commission earned" className="w-full min-w-[860px] text-left text-sm">
                    <thead className="border-b text-muted-foreground">
                      <tr>
                        {approver ? <th className="w-8 py-2 pr-2 font-medium">Approve</th> : null}
                        <th className="py-2 pr-4 font-medium">Invoice</th>
                        <th className="py-2 pr-4 font-medium">Date</th>
                        <th className="py-2 pr-4 font-medium">Customer and item</th>
                        <th className="py-2 pr-4 font-medium">For</th>
                        <th className="py-2 pr-4 text-right font-medium">On sales of</th>
                        <th className="py-2 pr-4 text-right font-medium">Earned</th>
                        <th className="py-2 pr-4 text-right font-medium">Released</th>
                        <th className="py-2 pr-4 text-right font-medium">Paid</th>
                        <th className="py-2 font-medium">Where it stands</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.map((row) => (
                        <tr key={row.id}>
                          {approver ? (
                            <td className="py-2 pr-2">
                              {payable(row).gt(0) && !row.approved ? <input type="checkbox" name="accrualId" value={row.id} defaultChecked aria-label={`Approve ${row.invoiceNumber ?? "this commission"}`} /> : null}
                            </td>
                          ) : null}
                          <td className="py-2 pr-4 font-medium whitespace-nowrap">
                            {row.invoiceNumber && can(session.role, "sales.read") ? (
                              <Link href={`/sales/${row.invoiceId}`} className="underline-offset-4 hover:underline">
                                {row.invoiceNumber}
                              </Link>
                            ) : (
                              (row.invoiceNumber ?? "An invoice")
                            )}
                          </td>
                          <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.invoiceDate)}</td>
                          <td className="py-2 pr-4">
                            {row.customerName ?? ""}
                            {row.itemCode ? <span className="text-muted-foreground"> {row.itemCode}</span> : null}
                          </td>
                          <td className="py-2 pr-4">{what(row, earned.names)}</td>
                          <td className={money}>{formatAmount(row.base)}</td>
                          <td className={money}>
                            {formatAmount(row.earned)}
                            {!row.earned.eq(row.accrued) ? <span className="block text-xs text-muted-foreground">was {formatAmount(row.accrued)}</span> : null}
                          </td>
                          <td className={money}>{formatAmount(row.released)}</td>
                          <td className={money}>{formatAmount(row.paid)}</td>
                          <td className="py-2">
                            {standingLabel(row)}
                            {owedBack(row).gt(0) ? <span className="tabular-nums">: {formatAmount(owedBack(row))}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {earned.more ? <p className="text-sm text-muted-foreground">Showing the newest 500.</p> : null}
              </ActionForm>
            )}
          </Card>
        ) : null}

        {person && payer && chosen ? (
          <Card title={`Pay ${chosen.name}`}>
            {justPaid ? (
              <p role="status" className="text-sm font-medium" data-testid="commission-paid">
                {paidLine(justPaid)}
              </p>
            ) : null}
            {totals.approved.isZero() ? (
              <p className="text-sm text-muted-foreground">Nothing is approved for payment. Approve what has been released first.</p>
            ) : (
              <ActionForm action={payCommissionAction.bind(null, person)} submitLabel="Pay commission">
                <p className="text-sm" data-testid="commission-due">
                  Approved: <span className="font-semibold tabular-nums">{formatAmount(due.gross)}</span>.
                  {due.recovered.gt(0) ? (
                    <>
                      {" "}
                      Owed back from before: <span className="font-semibold tabular-nums">{formatAmount(totals.owedBack)}</span>, of which <span className="tabular-nums">{formatAmount(due.recovered)}</span> comes out of this payment.
                    </>
                  ) : null}{" "}
                  To pay now: <span className="font-semibold tabular-nums">{formatAmount(due.amount)}</span>.
                </p>
                <div className="grid gap-4 sm:grid-cols-[10rem_1fr_1fr]">
                  <Field label="Date" name="date" id="pay-date" type="date" defaultValue={todayIso(new Date())} max={todayIso(new Date())} required />
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="pay-account" className="text-sm font-medium">
                      Paid from
                    </label>
                    <select id="pay-account" name="accountId" required className={SELECT} defaultValue={accounts[0]?.id ?? ""}>
                      {accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.code} {account.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <Field label="Note" name="note" id="pay-note" maxLength={300} autoComplete="off" />
                </div>
              </ActionForm>
            )}
          </Card>
        ) : null}

        <Card title="Payments">
          {payments.length === 0 ? (
            <Empty>No commission has been paid yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Commission payments" className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Number</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">To</th>
                    <th className="py-2 pr-4 text-right font-medium">Approved</th>
                    <th className="py-2 pr-4 text-right font-medium">Taken back</th>
                    <th className="py-2 pr-4 text-right font-medium">Paid</th>
                    <th className="py-2 font-medium">From</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {payments.map((payment) => (
                    <tr key={payment.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">{payment.number}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(payment.date)}</td>
                      <td className="py-2 pr-4">{payment.name}</td>
                      <td className={money}>{formatAmount(payment.gross)}</td>
                      <td className={money}>{payment.recovered.isZero() ? "" : formatAmount(payment.recovered)}</td>
                      <td className={money}>{formatAmount(payment.amount)}</td>
                      <td className="py-2">{payment.accountName ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
