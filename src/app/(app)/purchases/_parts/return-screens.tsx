import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { formatQuantity } from "@/modules/inventory/rules";
import type { BillOwed } from "@/modules/supplier-payments/rules";
import { getReturn, getReturnStart, listReceiptsToReturn, listReturns, type ReceiptToReturn, type ReturnLineRow } from "@/modules/supplier-returns/queries";
import { RETURN_STATUS_LABELS, type Returnable } from "@/modules/supplier-returns/rules";
import { can } from "@/modules/tenant/rules";
import { applyReturnCreditAction, discardReturnAction, saveReturnAction } from "./return-actions";
import { CreditForm, ReturnForm, type ReturnRow } from "./return-form";
import { Back, Pill, Refused, Sections } from "./screens";

const NO_RETURNS = "Only an owner, an accountant or an auditor can see supplier returns.";
const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");

/** The rows a return's form shows: everything that can go back, with what the draft already sends back of each. */
function returnRows(canGoBack: readonly Returnable[], held: readonly ReturnLineRow[] = []): ReturnRow[] {
  const mine = new Map(held.map((line) => [`${line.receiptLineId}|${line.billLineId ?? ""}`, formatQuantity(line.quantity)]));
  return canGoBack.map((row) => ({
    receiptLineId: row.receiptLineId,
    billLineId: row.billLineId ?? "",
    itemCode: row.itemCode,
    description: row.description,
    unitCode: row.unitCode,
    billed: row.billNumber ? `On ${row.billNumber}` : "Not yet billed",
    available: formatQuantity(row.available),
    unitValue: row.unitValue.toFixed(),
    unitTax: row.unitTax.toFixed(),
    quantity: mine.get(`${row.receiptLineId}|${row.billLineId ?? ""}`) ?? "",
  }));
}

/** What a posted line took back: off goods received and not billed, or off the bill. Nothing on a draft. */
function takenBackAt(line: ReturnLineRow): string {
  const value = line.grniValue ?? line.amount;
  return value ? formatAmount(value) : "";
}

const billRows = (owed: readonly BillOwed[]) => owed.map((bill) => ({ billId: bill.billId, number: bill.number, supplierInvoiceNo: bill.supplierInvoiceNo, date: formatIsoDate(bill.date), owed: bill.owed.toFixed(2), amount: "" }));

function ReceiptFacts({ receipt }: { receipt: ReceiptToReturn }) {
  return (
    <p className="mb-4 text-sm text-muted-foreground">
      Goods received on {receipt.number}, {formatIsoDate(receipt.date)}, from {receipt.supplierName}, against order {receipt.orderNumber}, into {receipt.warehouseName}.
    </p>
  );
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export async function ReturnsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "supplier_return.read") || !session.modules.purchasing) return <Refused title="Supplier returns">{NO_RETURNS}</Refused>;
  const { rows, more } = await listReturns(session);
  return (
    <>
      <PageHead title="Supplier returns" sub="Goods sent back to suppliers. Goods not yet billed come off what is waiting for a bill; billed goods are a debit note, which the supplier owes back." />
      <Sections session={session} current="/purchases/returns" />
      {can(session.role, "supplier_return.manage") ? (
        <p className="mb-4">
          <Link href="/purchases/returns/new" className={buttonVariants()}>
            New supplier return
          </Link>
        </p>
      ) : null}
      <Card className="max-w-5xl">
        {rows.length === 0 ? (
          <Empty>No goods have been sent back yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Supplier returns" className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Goods received</th>
                  <th className="py-2 pr-4 text-right font-medium">Not billed</th>
                  <th className="py-2 pr-4 text-right font-medium">Owed back</th>
                  <th className="py-2 pr-4 text-right font-medium">Credit left</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/purchases/returns/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.supplierName}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.receiptNumber}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.grniValue.isZero() ? "" : formatAmount(row.grniValue)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.credit.isZero() ? "" : formatAmount(row.credit)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.creditLeft.isZero() ? "" : formatAmount(row.creditLeft)}</td>
                    <td className="py-2">
                      <Pill label={RETURN_STATUS_LABELS[row.status]} strong={row.status === "posted"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 returns.</p> : null}
      </Card>
    </>
  );
}

// ── writing a return ────────────────────────────────────────────────────────────────────────────

export async function NewReturnScreen({ searchParams }: { searchParams: Promise<{ receipt?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_return.manage") || !session.modules.purchasing) return <Refused title="New supplier return">Only an owner or an accountant can send goods back to a supplier.</Refused>;
  const query = await searchParams;
  const back = <Back href="/purchases/returns" label="Supplier returns" />;
  const start = first(query.receipt) ? await getReturnStart(session, first(query.receipt)) : null;

  if (!start) {
    const receipts = await listReceiptsToReturn(session);
    return (
      <>
        {back}
        <PageHead title="New supplier return" sub="Choose the goods received note the goods came in on." />
        <Card className="max-w-4xl">
          {receipts.length === 0 ? (
            <Empty>No goods have been received yet, so there is nothing to send back.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Goods received notes" className="w-full min-w-[620px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Goods received</th>
                    <th className="py-2 pr-4 font-medium">Arrived on</th>
                    <th className="py-2 pr-4 font-medium">Supplier</th>
                    <th className="py-2 pr-4 font-medium">Order</th>
                    <th className="py-2 font-medium">Warehouse</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {receipts.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        <Link href={`/purchases/returns/new?receipt=${row.id}`} className="underline-offset-4 hover:underline">
                          {row.number}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                      <td className="py-2 pr-4">{row.supplierName}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.orderNumber}</td>
                      <td className="py-2">{row.warehouseName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {receipts.length === 200 ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 notes. For an older one, open it under Receive goods and send goods back from there.</p> : null}
        </Card>
      </>
    );
  }

  const { receipt, canGoBack } = start;
  return (
    <>
      {back}
      <PageHead title={`Goods going back to ${receipt.supplierName}`} sub="It gets its number when it is posted." />
      <Card className="max-w-5xl">
        <ReceiptFacts receipt={receipt} />
        {canGoBack.length === 0 ? (
          <Empty>Everything on this note has already been sent back.</Empty>
        ) : (
          <ReturnForm action={saveReturnAction.bind(null, null, receipt.id, "")} rows={returnRows(canGoBack)} initial={{ date: todayIso(new Date()), reason: "", supplierReference: "" }} />
        )}
      </Card>
    </>
  );
}

export async function ReturnScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[]; saved?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_return.read") || !session.modules.purchasing) return <Refused title="Supplier return">{NO_RETURNS}</Refused>;
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const found = await getReturn(session, id);
  if (!found) notFound();
  const loadedAt = found.updatedAt.toISOString();
  const back = <Back href="/purchases/returns" label="Supplier returns" />;
  const manage = can(session.role, "supplier_return.manage");
  const receipt = found.receipt;

  if (found.status === "draft" && manage) {
    return (
      <>
        {back}
        <PageHead title={`Draft return to ${receipt.supplierName}`} sub="Nothing has left the warehouse in the books yet. It gets its number when it is posted." />
        <div className="flex max-w-5xl flex-col gap-5">
          {first(query.saved) ? (
            <p role="status" className="text-sm text-muted-foreground">
              Draft saved.
            </p>
          ) : null}
          <Card>
            <ReceiptFacts receipt={receipt} />
            <ReturnForm
              action={saveReturnAction.bind(null, found.id, receipt.id, loadedAt)}
              rows={returnRows(found.canGoBack, found.lines)}
              initial={{ date: found.date, reason: found.reason, supplierReference: found.supplierReference ?? "" }}
              refused={first(query.refused) ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardReturnAction.bind(null, found.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const posted = found.status === "posted";
  return (
    <>
      {back}
      <PageHead title={found.number ?? `Draft return to ${receipt.supplierName}`} sub={found.reason} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Supplier</dt>
            <dd>
              <Link href={`/suppliers/${receipt.supplierId}`} className="underline-offset-4 hover:underline">
                {receipt.supplierName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Sent back on</dt>
            <dd>{formatIsoDate(found.date)}</dd>
            <dt className="text-muted-foreground">Goods received</dt>
            <dd>
              {can(session.role, "goods_receipt.read") ? (
                <Link href={`/purchases/receipts/${receipt.id}`} className="underline-offset-4 hover:underline">
                  {receipt.number}
                </Link>
              ) : (
                receipt.number
              )}
              <span className="text-muted-foreground"> of {formatIsoDate(receipt.date)}, out of {receipt.warehouseName}</span>
            </dd>
            {found.supplierReference ? (
              <>
                <dt className="text-muted-foreground">Supplier&apos;s credit note</dt>
                <dd>{found.supplierReference}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Pill label={RETURN_STATUS_LABELS[found.status]} strong={posted} testId="document-status" />
              {posted ? <span className="text-muted-foreground"> A posted return is never changed.</span> : null}
            </dd>
            {found.journalId && can(session.role, "journal.read") ? (
              <>
                <dt className="text-muted-foreground">In the books</dt>
                <dd>
                  <Link href={`/journals/${found.journalId}`} className="underline-offset-4 hover:underline">
                    See the journal
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
          <div className="overflow-x-auto">
            <table aria-label="Goods sent back" className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Item code</th>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-4 font-medium">Billed</th>
                  <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                  <th className="py-2 pr-4 font-medium">Unit</th>
                  <th className="py-2 pr-4 text-right font-medium">Taken back at</th>
                  <th className="py-2 text-right font-medium">Sales tax</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {found.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                    <td className="py-2 pr-4">{line.description}</td>
                    <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">{line.billNumber ? `On ${line.billNumber}` : "Not yet billed"}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(line.quantity)}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{line.unitCode}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{takenBackAt(line)}</td>
                    <td className="py-2 text-right tabular-nums">{line.salesTax && !line.salesTax.isZero() ? formatAmount(line.salesTax) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {posted ? (
            <dl className="mt-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Came off goods received and not yet billed</dt>
              <dd className="text-right tabular-nums" data-testid="return-not-billed">
                {formatAmount(found.grniValue)}
              </dd>
              <dt className="text-muted-foreground">The supplier owes back for billed goods</dt>
              <dd className="text-right tabular-nums" data-testid="return-credit">
                {formatAmount(found.credit)}
              </dd>
              <dt className="text-muted-foreground">What the goods were carried at in stock</dt>
              <dd className="text-right tabular-nums" data-testid="return-stock-value">
                {formatAmount(found.stockValue)}
              </dd>
            </dl>
          ) : null}
        </Card>

        {posted && found.credit.gt(0) ? (
          <Card title="What the supplier owes back">
            {found.allocations.length === 0 ? (
              <p className="text-sm text-muted-foreground">None of it has been set against a bill.</p>
            ) : (
              <div className="overflow-x-auto">
                <table aria-label="Bills the credit was set against" className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b text-muted-foreground">
                    <tr>
                      <th className="py-2 pr-4 font-medium">Bill</th>
                      <th className="py-2 pr-4 font-medium">Their invoice</th>
                      <th className="py-2 pr-4 font-medium">Taken off it on</th>
                      <th className="py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {found.allocations.map((line) => (
                      <tr key={line.id}>
                        <td className="py-2 pr-4 font-medium whitespace-nowrap">
                          {can(session.role, "supplier_bill.read") ? (
                            <Link href={`/purchases/bills/${line.billId}`} className="underline-offset-4 hover:underline">
                              {line.billNumber}
                            </Link>
                          ) : (
                            line.billNumber
                          )}
                        </td>
                        <td className="py-2 pr-4">{line.supplierInvoiceNo}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(line.appliedOn)}</td>
                        <td className="py-2 text-right tabular-nums">{formatAmount(line.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-sm">
              Credit with the supplier not yet used:{" "}
              <span className="font-semibold tabular-nums" data-testid="return-credit-left">
                {formatAmount(found.creditLeft)}
              </span>
              {found.creditLeft.gt(0) ? <span className="text-muted-foreground">. It can be set against another bill of this supplier, or the supplier can pay it back.</span> : null}
            </p>
          </Card>
        ) : null}

        {posted && manage && found.creditLeft.gt(0) && found.billsOwed.length > 0 ? (
          <Card title="Set the credit against bills">
            <CreditForm action={applyReturnCreditAction.bind(null, found.id, loadedAt)} bills={billRows(found.billsOwed)} left={found.creditLeft.toFixed(2)} today={todayIso(new Date())} />
          </Card>
        ) : null}
      </div>
    </>
  );
}
