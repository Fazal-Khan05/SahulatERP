import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant, type TenantSession } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getMarketPurchaseOfPayment } from "@/modules/market-purchases/queries";
import { getPayment, getPaymentChoices, getWithholdingPosition, listBillsOwed, listPayments, type PaymentAllocation } from "@/modules/supplier-payments/queries";
import { PAYMENT_STATUS_LABELS, impliedRate, type BillOwed } from "@/modules/supplier-payments/rules";
import { WITHHOLDING_KIND_LABELS, type WithholdingKind } from "@/modules/tax/rules";
import { can } from "@/modules/tenant/rules";
import { applyAdvanceAction, cancelPaymentAction, discardPaymentAction, recordChallanAction, savePaymentAction } from "./payment-actions";
import { MarketPurchaseNote } from "./market-note";
import { AdvanceForm, PaymentForm } from "./payment-form";
import { Back, Pill, Refused, Sections } from "./screens";

const NO_PAYMENTS = "Only an owner, an accountant or an auditor can see supplier payments.";
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

/** The rows of unpaid bills a form shows, with what the draft already sets against each. */
function billRows(owed: readonly BillOwed[], held: readonly PaymentAllocation[] = []) {
  const mine = new Map(held.filter((line) => line.appliedOn === null).map((line) => [line.billId, line.amount.toFixed(2)]));
  return owed.map((bill) => ({ billId: bill.billId, number: bill.number, supplierInvoiceNo: bill.supplierInvoiceNo, date: formatIsoDate(bill.date), owed: bill.owed.toFixed(2), amount: mine.get(bill.billId) ?? "" }));
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export async function PaymentsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "supplier_payment.read") || !session.modules.purchasing) return <Refused title="Supplier payments">{NO_PAYMENTS}</Refused>;
  const { rows, more } = await listPayments(session);
  return (
    <>
      <PageHead title="Supplier payments" sub="Money paid to suppliers: against their bills, or ahead of them as an advance." />
      <Sections session={session} current="/purchases/payments" />
      {can(session.role, "supplier_payment.manage") ? (
        <p className="mb-4">
          <Link href="/purchases/payments/new" className={buttonVariants()}>
            New supplier payment
          </Link>
        </p>
      ) : null}
      <Card className="max-w-5xl">
        {rows.length === 0 ? (
          <Empty>No supplier payments yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Supplier payments" className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Paid from</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 pr-4 text-right font-medium">Advance left</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/purchases/payments/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.supplierName}</td>
                    <td className="py-2 pr-4">{row.accountName}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.amount)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.advance.isZero() ? "" : formatAmount(row.advance)}</td>
                    <td className="py-2">
                      <Pill label={PAYMENT_STATUS_LABELS[row.status]} strong={row.status === "posted"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 payments.</p> : null}
      </Card>
    </>
  );
}

// ── writing a payment ───────────────────────────────────────────────────────────────────────────

export async function NewPaymentScreen({ searchParams }: { searchParams: Promise<{ supplier?: string | string[]; branch?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_payment.manage") || !session.modules.purchasing) return <Refused title="New supplier payment">Only an owner or an accountant can pay suppliers.</Refused>;
  const query = await searchParams;
  const choices = await getPaymentChoices(session);
  const supplier = choices.suppliers.find((row) => row.id === first(query.supplier));
  const branch = choices.branches.find((row) => row.id === first(query.branch)) ?? (choices.branches.length === 1 ? choices.branches[0] : undefined);
  const back = <Back href="/purchases/payments" label="Supplier payments" />;

  if (!supplier || !branch) {
    return (
      <>
        {back}
        <PageHead title="New supplier payment" sub="Choose who is being paid. Their unpaid bills are then listed." />
        {choices.suppliers.length === 0 ? (
          <p className="text-muted-foreground">Add a supplier first, under Suppliers.</p>
        ) : (
          <Card className="max-w-xl">
            <form method="get" className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="supplier" className="text-sm font-medium">
                  Supplier
                </label>
                <select id="supplier" name="supplier" defaultValue={first(query.supplier)} required className={SELECT}>
                  <option value="">Choose a supplier</option>
                  {choices.suppliers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </div>
              {choices.branches.length > 1 ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="branch" className="text-sm font-medium">
                    Branch
                  </label>
                  <select id="branch" name="branch" defaultValue={first(query.branch)} required className={SELECT}>
                    <option value="">Choose a branch</option>
                    {choices.branches.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <button type="submit" className={`${buttonVariants()} self-start`}>
                Continue
              </button>
            </form>
          </Card>
        )}
      </>
    );
  }
  if (choices.accounts.length === 0) {
    return (
      <>
        {back}
        <PageHead title={`New payment to ${supplier.label}`} />
        <p className="text-muted-foreground">Money is paid out of a cash or bank account, and the chart of accounts has none in use. Add one under Settings, Chart of accounts.</p>
      </>
    );
  }
  const owed = await listBillsOwed(session, supplier.id, branch.id);
  return (
    <>
      {back}
      <PageHead title={`New payment to ${supplier.label}`} sub={`${branch.label} branch. It gets its number when it is posted.`} />
      <Card className="max-w-5xl">
        <PaymentForm
          action={savePaymentAction.bind(null, null, supplier.id, branch.id, "")}
          accounts={choices.accounts}
          currencies={choices.currencies}
          bills={billRows(owed)}
          initial={{ date: todayIso(new Date()), accountId: choices.accounts.length === 1 ? choices.accounts[0].id : "", reference: "", note: "", amount: "", foreignCurrency: "", foreignAmount: "" }}
        />
      </Card>
    </>
  );
}

export async function PaymentScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[]; saved?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_payment.read") || !session.modules.purchasing) return <Refused title="Supplier payment">{NO_PAYMENTS}</Refused>;
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const payment = await getPayment(session, id);
  if (!payment) notFound();
  const loadedAt = payment.updatedAt.toISOString();
  const back = <Back href="/purchases/payments" label="Supplier payments" />;
  const manage = can(session.role, "supplier_payment.manage");
  const today = todayIso(new Date());

  if (payment.status === "draft" && manage) {
    const choices = await getPaymentChoices(session);
    return (
      <>
        {back}
        <PageHead title={`Draft payment to ${payment.supplierName}`} sub={`${payment.branchName} branch. Nothing has been paid in the books yet. It gets its number when it is posted.`} />
        <div className="flex max-w-5xl flex-col gap-5">
          {first(query.saved) ? (
            <p role="status" className="text-sm text-muted-foreground">
              Draft saved.
            </p>
          ) : null}
          <Card>
            <PaymentForm
              action={savePaymentAction.bind(null, payment.id, payment.supplierId, payment.branchId, loadedAt)}
              accounts={choices.accounts}
              currencies={choices.currencies}
              bills={billRows(payment.billsOwed, payment.allocations)}
              initial={{ date: payment.date, accountId: payment.accountId, reference: payment.reference ?? "", note: payment.note ?? "", amount: payment.amount.toFixed(2), foreignCurrency: payment.foreignCurrency ?? "", foreignAmount: payment.foreignAmount?.toFixed(2) ?? "" }}
              refused={first(query.refused) ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardPaymentAction.bind(null, payment.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const posted = payment.status === "posted";
  const market = await getMarketPurchaseOfPayment(session, payment.id);
  return (
    <>
      {back}
      <PageHead title={payment.number ?? `Draft payment to ${payment.supplierName}`} sub={payment.note ?? undefined} />
      <MarketPurchaseNote purchase={market} on="payment" />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Supplier</dt>
            <dd>
              <Link href={`/suppliers/${payment.supplierId}`} className="underline-offset-4 hover:underline">
                {payment.supplierName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Paid on</dt>
            <dd>{formatIsoDate(payment.date)}</dd>
            <dt className="text-muted-foreground">Paid from</dt>
            <dd>{payment.accountName}</dd>
            {payment.reference ? (
              <>
                <dt className="text-muted-foreground">Reference</dt>
                <dd>{payment.reference}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular-nums" data-testid="payment-amount">
              {formatAmount(payment.amount)}
              {payment.foreignCurrency && payment.foreignAmount ? (
                <span className="text-muted-foreground">
                  {" "}
                  ({payment.foreignCurrency} {formatAmount(payment.foreignAmount)}, at {impliedRate(payment.amount, payment.foreignAmount).toFixed()} rupees each; kept for the record)
                </span>
              ) : null}
            </dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Pill label={PAYMENT_STATUS_LABELS[payment.status]} strong={posted} testId="document-status" />
              {payment.status === "cancelled" ? (
                <span className="text-muted-foreground">
                  {" "}
                  on {payment.cancelledOn ? formatIsoDate(payment.cancelledOn) : ""}: {payment.cancelReason}. Everything it posted was reversed.
                </span>
              ) : null}
            </dd>
            {payment.journalId && can(session.role, "journal.read") ? (
              <>
                <dt className="text-muted-foreground">In the books</dt>
                <dd>
                  <Link href={`/journals/${payment.journalId}`} className="underline-offset-4 hover:underline">
                    See the journal
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
          {payment.allocations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing of it is set against a bill.</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Bills settled" className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Bill</th>
                    <th className="py-2 pr-4 font-medium">Their invoice</th>
                    <th className="py-2 pr-4 font-medium">Set against it</th>
                    <th className="py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {payment.allocations.map((line) => (
                    <tr key={line.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        <Link href={`/purchases/bills/${line.billId}`} className="underline-offset-4 hover:underline">
                          {line.billNumber}
                        </Link>
                      </td>
                      <td className="py-2 pr-4">{line.supplierInvoiceNo}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{line.appliedOn ? `from the advance, on ${formatIsoDate(line.appliedOn)}` : "with the payment"}</td>
                      <td className="py-2 text-right tabular-nums">{formatAmount(line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {payment.status !== "draft" ? (
            <p className="mt-3 text-sm">
              {posted ? "Left as an advance" : "Was left as an advance"}:{" "}
              <span className="font-semibold tabular-nums" data-testid="payment-advance-left">
                {formatAmount(payment.advance)}
              </span>
            </p>
          ) : null}
        </Card>

        {posted && manage && payment.advance.gt(0) && payment.billsOwed.length > 0 ? (
          <Card title="Set the advance against bills">
            <AdvanceForm action={applyAdvanceAction.bind(null, payment.id, loadedAt)} bills={billRows(payment.billsOwed)} left={payment.advance.toFixed(2)} today={today} />
          </Card>
        ) : null}

        {posted && manage ? (
          <Card title="Cancel this payment">
            <p className="mb-3 text-sm text-muted-foreground">For a payment entered by mistake. Everything it posted is reversed on the day given, the bills it settled are owed again, and it keeps its number, marked cancelled, with the reason.</p>
            <ActionForm action={cancelPaymentAction.bind(null, payment.id, loadedAt)} submitLabel="Cancel payment" className="max-w-md">
              <Field label="Cancelled on" name="date" id="cancel-date" type="date" defaultValue={today} required />
              <Field label="Reason" name="reason" required maxLength={300} autoComplete="off" placeholder="Such as: entered twice" />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── tax withheld, and its challans ──────────────────────────────────────────────────────────────

const KIND_WORDS: Record<WithholdingKind, string> = { income_tax: "Income tax", sales_tax: "Sales tax", provincial_sales_tax: "Provincial sales tax" };

/** What has been withheld and not yet paid over, with the form that records a challan, and the challans recorded. Shown under Withholding tax. */
export async function ChallanCards({ session }: { session: TenantSession }) {
  if (!can(session.role, "supplier_payment.read")) return null;
  const [{ unpaid, challans }, choices] = await Promise.all([getWithholdingPosition(session), getPaymentChoices(session)]);
  const record = can(session.role, "supplier_payment.manage") && session.branchIds === null && choices.accounts.length > 0;
  const total = unpaid.reduce((sum, entry) => sum.plus(entry.amount), new Decimal(0));
  const table = (
    <div className="overflow-x-auto">
      <table aria-label="Tax withheld, not yet paid over" className="w-full min-w-[720px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            {record ? <th className="w-8 py-2" /> : null}
            <th className="py-2 pr-4 font-medium">Withheld on</th>
            <th className="py-2 pr-4 font-medium">Tax</th>
            <th className="py-2 pr-4 font-medium">Supplier</th>
            <th className="py-2 pr-4 font-medium">Bill</th>
            <th className="py-2 pr-4 font-medium">Line</th>
            <th className="py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {unpaid.map((entry, index) => (
            <tr key={entry.entryId}>
              {record ? (
                <td className="py-2">
                  <input type="checkbox" name="entryId" value={entry.entryId} aria-label={`Paid by this challan, row ${index + 1}`} />
                </td>
              ) : null}
              <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(entry.date)}</td>
              <td className="py-2 pr-4">{KIND_WORDS[entry.kind]}</td>
              <td className="py-2 pr-4">{entry.supplierName}</td>
              <td className="py-2 pr-4 whitespace-nowrap">{entry.billNumber}</td>
              <td className="py-2 pr-4 text-muted-foreground">{entry.label}</td>
              <td className="py-2 text-right tabular-nums">{formatAmount(entry.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <Card title="Tax withheld, not yet paid to the government" className="max-w-5xl">
        {unpaid.length === 0 ? (
          <Empty>Nothing withheld is waiting to be paid over.</Empty>
        ) : record ? (
          <ActionForm action={recordChallanAction} submitLabel="Record the challan">
            <p className="text-sm">
              In all: <span className="font-semibold tabular-nums" data-testid="withheld-unpaid">{formatAmount(total)}</span>. Tick the amounts one challan paid (all of one kind of tax), then enter the challan.
            </p>
            {table}
            <div className="grid gap-4 sm:grid-cols-[14rem_10rem_1fr_1fr]">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="kind" className="text-sm font-medium">
                  Which tax
                </label>
                <select id="kind" name="kind" required className={SELECT} defaultValue="">
                  <option value="">Choose the tax</option>
                  {(Object.keys(KIND_WORDS) as WithholdingKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {WITHHOLDING_KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
              </div>
              <Field label="Paid on" name="paidOn" type="date" defaultValue={todayIso(new Date())} required />
              <Field label="Challan (CPR) number" name="challanNo" required maxLength={60} autoComplete="off" />
              <div className="flex flex-col gap-1.5">
                <label htmlFor="challan-account" className="text-sm font-medium">
                  Paid from
                </label>
                <select id="challan-account" name="accountId" required className={SELECT} defaultValue={choices.accounts.length === 1 ? choices.accounts[0].id : ""}>
                  <option value="">Choose a cash or bank account</option>
                  {choices.accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </ActionForm>
        ) : (
          <>
            <p className="mb-2 text-sm">
              In all: <span className="font-semibold tabular-nums" data-testid="withheld-unpaid">{formatAmount(total)}</span>.
            </p>
            {table}
          </>
        )}
      </Card>
      <Card title="Challans" className="max-w-5xl">
        {challans.length === 0 ? (
          <Empty>No challan has been recorded yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Challans" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Paid on</th>
                  <th className="py-2 pr-4 font-medium">Tax</th>
                  <th className="py-2 pr-4 font-medium">Challan (CPR)</th>
                  <th className="py-2 pr-4 font-medium">Paid from</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {challans.map((challan) => (
                  <tr key={challan.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      {can(session.role, "journal.read") ? (
                        <Link href={`/journals/${challan.journalId}`} className="underline-offset-4 hover:underline">
                          {challan.number}
                        </Link>
                      ) : (
                        challan.number
                      )}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(challan.paidOn)}</td>
                    <td className="py-2 pr-4">{KIND_WORDS[challan.kind]}</td>
                    <td className="py-2 pr-4">{challan.challanNo}</td>
                    <td className="py-2 pr-4">{challan.accountName}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(challan.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
