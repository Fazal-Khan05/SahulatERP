import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { listCashBankAccounts } from "@/modules/cash-bank/queries";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getMoneyInOut, listMoneyInOut, listOtherAccounts } from "@/modules/money-in-out/queries";
import { WORDS, type Direction } from "@/modules/money-in-out/rules";
import { can } from "@/modules/tenant/rules";
import { cancelMoneyInOutAction, moneyInOutAction } from "./money-actions";
import { Books, CancelCard, CashNav, SELECT, Shut, Status, closed } from "./screens";

// Money in and money out (batch A): money into or out of a cash or bank account that no other
// form records, such as the owner's capital, a loan received or repaid, drawings, other income.

const SUB: Record<Direction, string> = {
  in: "Money that came into a cash or bank account and is not a customer's payment: the owner's capital, a loan received, other income.",
  out: "Money that went out of a cash or bank account and is not a supplier payment, an expense or a salary: drawings, a loan repaid.",
};

export async function MoneyInOutScreen({ direction }: { direction: Direction }) {
  const words = WORDS[direction];
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title={words.title} why={why} />;
  // The company's accounts belong to the whole company: kept by someone who works in every branch.
  const whole = session.branchIds === null;
  const manager = can(session.role, "cash_bank.manage") && whole;
  const [rows, accounts, others] = await Promise.all([whole ? listMoneyInOut(session, direction) : [], listCashBankAccounts(session), manager ? listOtherAccounts(session, direction) : []]);
  const usable = accounts.filter((a) => !a.archived);
  return (
    <>
      <PageHead title={words.title} sub={SUB[direction]} />
      <CashNav here={direction === "in" ? "money-in" : "money-out"} />
      <div className="flex max-w-5xl flex-col gap-5">
        {!whole ? <p className="text-sm text-muted-foreground">Money in and out of the company&apos;s accounts is kept by someone who works in every branch.</p> : null}
        {manager ? (
          <Card title={words.record}>
            <ActionForm action={moneyInOutAction.bind(null, direction)} submitLabel={words.record}>
              {/* One key for this entry, however many times it is sent: it is recorded once. */}
              <input type="hidden" name="clientKey" value={randomUUID()} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="moneyAccountId">{words.account}</Label>
                  <select id="moneyAccountId" name="moneyAccountId" className={SELECT} required>
                    <option value="">Choose a cash or bank account</option>
                    {usable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="otherAccountId">{words.other}</Label>
                  <select id="otherAccountId" name="otherAccountId" className={SELECT} required>
                    <option value="">Choose, such as {direction === "in" ? "Owner's capital or Other income" : "Drawings or a loan"}</option>
                    {others.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} {a.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-[10rem_10rem_minmax(0,1fr)]">
                <Field label="Date" name="date" type="date" defaultValue={todayIso(new Date())} required />
                <Field label="Amount" name="amount" inputMode="decimal" autoComplete="off" required />
                <Field label={words.party} name="party" maxLength={120} autoComplete="off" required />
              </div>
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <Field label="Reference (cheque or slip no.)" name="reference" maxLength={60} autoComplete="off" />
                <Field label="Note" name="memo" maxLength={300} autoComplete="off" />
              </div>
              {direction === "out" ? <p className="text-sm text-muted-foreground">Spending on the business (rent, fuel, repairs) is entered under Expenses, which withholds tax where it applies.</p> : null}
            </ActionForm>
          </Card>
        ) : null}
        {whole ? (
          <Card>
            {rows.length === 0 ? (
              <Empty>Nothing recorded yet.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table aria-label={words.list} className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Number</th>
                      <th className="py-2 pr-4 font-medium">Date</th>
                      <th className="py-2 pr-4 font-medium">{direction === "in" ? "From" : "To"}</th>
                      <th className="py-2 pr-4 font-medium">{words.account}</th>
                      <th className="py-2 pr-4 font-medium">{words.other}</th>
                      <th className="py-2 pr-4 text-right font-medium">Amount</th>
                      <th className="py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <td className="py-2 pr-4 font-medium whitespace-nowrap">
                          <Link href={`/cash-bank/money/${row.id}`} className="underline-offset-4 hover:underline">
                            {row.number}
                          </Link>
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                        <td className="py-2 pr-4">{row.party}</td>
                        <td className="py-2 pr-4">{row.account}</td>
                        <td className="py-2 pr-4">{row.other}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.amount)}</td>
                        <td className="py-2">
                          <Status status={row.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        ) : null}
      </div>
    </>
  );
}

export async function MoneyInOutEntryScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const why = closed(session);
  if (why) return <Shut title="Money in or out" why={why} />;
  const found = session.branchIds === null ? await getMoneyInOut(session, (await params).id) : null;
  if (!found) notFound();
  const words = WORDS[found.direction];
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={found.direction === "in" ? "/cash-bank/money-in" : "/cash-bank/money-out"} className="text-muted-foreground underline-offset-4 hover:underline">
          {words.list}
        </Link>
      </p>
      <PageHead title={found.number} sub={`${words.title}: ${formatAmount(found.amount)} ${found.direction === "in" ? "from" : "to"} ${found.party}, ${found.direction === "in" ? "into" : "out of"} ${found.account}, ${formatIsoDate(found.date)}.`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <p className="text-sm" data-testid="document-status">
          <Status status={found.status} /> {found.other}.{found.reference ? ` Reference ${found.reference}.` : ""}
          {found.memo ? ` ${found.memo}` : ""}
          {found.cancelReason ? ` Cancelled: ${found.cancelReason}.` : ""}
        </p>
        <Books title="In the books" lines={found.journal} />
        <Books title="Taken back" lines={found.reversal} />
        {found.status === "posted" && can(session.role, "cash_bank.manage") ? <CancelCard action={cancelMoneyInOutAction.bind(null, found.id)} word="entry" /> : null}
      </div>
    </>
  );
}
