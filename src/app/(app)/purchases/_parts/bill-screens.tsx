import type Decimal from "decimal.js";
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
import { getBill, getBillChoices, getPurchaseSettings, listBills, listReceiptLinesToBill, type BillChoices, type BillLine } from "@/modules/supplier-bills/queries";
import { BILL_STATUS_LABELS, stillToBill, suggestedIncomeTaxCode, type ReceiptLineToBill, type Withheld } from "@/modules/supplier-bills/rules";
import { WITHHOLDING_KIND_LABELS, formatPercent } from "@/modules/tax/rules";
import { can } from "@/modules/tenant/rules";
import { discardBillAction, saveBillAction, setWithholdingAction } from "./bill-actions";
import { BillForm } from "./bill-form";
import { Back, Pill, Refused, Sections } from "./screens";

const NO_BILLS = "Only an owner, an accountant or an auditor can see supplier bills.";
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const first = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");
/** A price of one: as an amount, or with the third and fourth decimals it was typed with. */
const price = (value: Decimal) => (value.decimalPlaces() <= 2 ? formatAmount(value) : value.toFixed(Math.min(value.decimalPlaces(), 4)));

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export async function BillsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "supplier_bill.read") || !session.modules.purchasing) return <Refused title="Supplier bills">{NO_BILLS}</Refused>;
  const { rows, more } = await listBills(session);
  return (
    <>
      <PageHead title="Supplier bills" sub="What suppliers have billed, for goods received or for services. A posted bill is what is owed to the supplier." />
      <Sections session={session} current="/purchases/bills" />
      {can(session.role, "supplier_bill.manage") ? (
        <p className="mb-4">
          <Link href="/purchases/bills/new" className={buttonVariants()}>
            New supplier bill
          </Link>
        </p>
      ) : null}
      <Card className="max-w-5xl">
        {rows.length === 0 ? (
          <Empty>No supplier bills yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Supplier bills" className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Their invoice</th>
                  <th className="py-2 pr-4 text-right font-medium">Total</th>
                  <th className="py-2 pr-4 text-right font-medium">Withheld</th>
                  <th className="py-2 pr-4 text-right font-medium">Owed</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/purchases/bills/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.supplierName}</td>
                    <td className="py-2 pr-4">{row.supplierInvoiceNo}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.total)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.status === "posted" ? formatAmount(row.withheld) : ""}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.status === "posted" ? formatAmount(row.payable) : ""}</td>
                    <td className="py-2">
                      <Pill label={BILL_STATUS_LABELS[row.status]} strong={row.status === "posted"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 bills.</p> : null}
      </Card>
    </>
  );
}

// ── writing a bill ──────────────────────────────────────────────────────────────────────────────

const byKind = (choices: BillChoices) =>
  choices.withholdingOn
    ? {
        income: choices.withholding.filter((line) => line.kind === "income_tax"),
        sales: choices.salesTaxRegistered ? choices.withholding.filter((line) => line.kind === "sales_tax") : [],
        provincial: choices.withholding.filter((line) => line.kind === "provincial_sales_tax"),
      }
    : null;

/** The rows of goods the form shows: what is still to bill, with what the draft already holds of each. */
function goodsRows(toBill: readonly ReceiptLineToBill[], onDraft: readonly BillLine[], taxAllowed: boolean) {
  const held = new Map(onDraft.filter((line) => line.kind === "goods").map((line) => [line.receiptLineId, line]));
  return toBill.map((line) => {
    const mine = held.get(line.receiptLineId);
    return {
      receiptLineId: line.receiptLineId,
      receiptNumber: `${line.receiptNumber}, ${formatIsoDate(line.receiptDate)}`,
      itemCode: line.itemCode,
      description: line.description,
      unitCode: line.unitCode,
      left: formatQuantity(stillToBill(line)),
      quantity: mine?.quantity ? formatQuantity(mine.quantity) : "",
      price: (mine?.unitPrice ?? line.orderCost).toFixed(),
      taxCategoryId: mine ? (mine.taxCategoryId ?? "") : taxAllowed ? (line.taxCategoryId ?? "") : "",
    };
  });
}

export async function NewBillScreen({ searchParams }: { searchParams: Promise<{ supplier?: string | string[]; branch?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_bill.manage") || !session.modules.purchasing) return <Refused title="New supplier bill">Only an owner or an accountant can write supplier bills.</Refused>;
  const query = await searchParams;
  const today = todayIso(new Date());
  const choices = await getBillChoices(session, today);
  const supplier = choices.suppliers.find((row) => row.id === first(query.supplier));
  const branch = choices.branches.find((row) => row.id === first(query.branch)) ?? (choices.branches.length === 1 ? choices.branches[0] : undefined);
  const back = <Back href="/purchases/bills" label="Supplier bills" />;

  if (!supplier || !branch) {
    return (
      <>
        {back}
        <PageHead title="New supplier bill" sub="Choose whose bill it is. The goods received from them and not yet billed are then listed." />
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

  const toBill = await listReceiptLinesToBill(session, supplier.id, branch.id);
  const taxAllowed = choices.salesTaxRegistered && supplier.registered;
  const lines = byKind(choices);
  const suggested = suggestedIncomeTaxCode(supplier.type, toBill.length > 0);
  return (
    <>
      {back}
      <PageHead title={`New bill from ${supplier.label}`} sub={`${branch.label} branch. It gets its number when it is posted.`} />
      <Card className="max-w-6xl">
        <BillForm
          action={saveBillAction.bind(null, null, supplier.id, branch.id, "")}
          goods={goodsRows(toBill, [], taxAllowed)}
          expenses={[]}
          accounts={choices.accounts}
          taxCategories={taxAllowed ? choices.taxCategories : []}
          withholding={lines}
          initial={{ date: today, supplierInvoiceNo: "", dueDate: "", note: "", incomeTaxCode: lines?.income.some((line) => line.code === suggested) ? suggested : "", salesTaxCode: "", provincialTaxCode: "" }}
        />
      </Card>
    </>
  );
}

function Figures({ rows, total }: { rows: [string, string][]; total: [string, string] }) {
  return (
    <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right tabular-nums">{value}</dd>
        </div>
      ))}
      <dt className="border-t pt-1 font-semibold">{total[0]}</dt>
      <dd className="border-t pt-1 text-right font-semibold tabular-nums" data-testid="bill-payable">
        {total[1]}
      </dd>
    </dl>
  );
}

const WITHHELD_WORDS = { income_tax: "Income tax withheld", sales_tax: "Sales tax withheld", provincial_sales_tax: "Provincial sales tax withheld" } as const;

const withheldRows = (entries: readonly Pick<Withheld, "kind" | "label" | "base" | "rate" | "amount">[]): [string, string][] =>
  entries.map((entry) => [`${WITHHELD_WORDS[entry.kind]}: ${entry.label}, ${formatPercent(entry.rate)} of ${formatAmount(entry.base)}`, `− ${formatAmount(entry.amount)}`]);

export async function BillScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[]; saved?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "supplier_bill.read") || !session.modules.purchasing) return <Refused title="Supplier bill">{NO_BILLS}</Refused>;
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const bill = await getBill(session, id);
  if (!bill) notFound();
  const loadedAt = bill.updatedAt.toISOString();
  const back = <Back href="/purchases/bills" label="Supplier bills" />;
  const totals: [string, string][] = [
    ["Lines before tax", formatAmount(bill.amount)],
    ...(bill.salesTax.isZero() ? [] : ([["Sales tax (input tax)", formatAmount(bill.salesTax)]] as [string, string][])),
    ...(bill.provincialTax.isZero() ? [] : ([["Provincial sales tax on services", formatAmount(bill.provincialTax)]] as [string, string][])),
    ["Bill total", formatAmount(bill.total)],
  ];

  if (bill.status === "draft" && can(session.role, "supplier_bill.manage")) {
    const choices = await getBillChoices(session, bill.date);
    const supplier = choices.suppliers.find((row) => row.id === bill.supplierId);
    const taxAllowed = choices.salesTaxRegistered && (supplier?.registered ?? false);
    const toBill = await listReceiptLinesToBill(session, bill.supplierId, bill.branchId);
    return (
      <>
        {back}
        <PageHead title={`Draft bill from ${bill.supplierName}`} sub={`${bill.branchName} branch. Nothing is in the books yet. It gets its number when it is posted.`} />
        <div className="flex max-w-6xl flex-col gap-5">
          {first(query.saved) ? (
            <p role="status" className="text-sm text-muted-foreground">
              Draft saved.
            </p>
          ) : null}
          <Card title="What posting this bill will do">
            {bill.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is on the bill yet.</p>
            ) : bill.preview?.ok ? (
              <Figures rows={[...totals, ...withheldRows(bill.preview.figures.withheld)]} total={["Owed to the supplier", formatAmount(bill.preview.figures.payable)]} />
            ) : (
              <p role="alert" className="text-sm text-destructive" data-testid="bill-preview-problem">
                {bill.preview?.reason} Save the draft again after putting it right.
              </p>
            )}
          </Card>
          <Card>
            <BillForm
              action={saveBillAction.bind(null, bill.id, bill.supplierId, bill.branchId, loadedAt)}
              goods={goodsRows(toBill, bill.lines, taxAllowed)}
              expenses={bill.lines.filter((line) => line.kind === "expense").map((line) => ({ accountId: line.accountId ?? "", description: line.description, amount: line.amount.toFixed(2), taxCategoryId: line.taxCategoryId ?? "" }))}
              accounts={choices.accounts}
              taxCategories={taxAllowed ? choices.taxCategories : []}
              withholding={byKind(choices)}
              initial={{ date: bill.date, supplierInvoiceNo: bill.supplierInvoiceNo, dueDate: bill.dueDate ?? "", note: bill.note ?? "", incomeTaxCode: bill.incomeTaxCode ?? "", salesTaxCode: bill.salesTaxCode ?? "", provincialTaxCode: bill.provincialTaxCode ?? "" }}
              refused={first(query.refused) ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardBillAction.bind(null, bill.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      {back}
      <PageHead title={bill.number ?? `Draft bill from ${bill.supplierName}`} sub={bill.note ?? undefined} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Supplier</dt>
            <dd>
              <Link href={`/suppliers/${bill.supplierId}`} className="underline-offset-4 hover:underline">
                {bill.supplierName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Their invoice</dt>
            <dd>
              {bill.supplierInvoiceNo}, {formatIsoDate(bill.date)}
            </dd>
            {bill.dueDate ? (
              <>
                <dt className="text-muted-foreground">Due on</dt>
                <dd>{formatIsoDate(bill.dueDate)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Branch</dt>
            <dd>{bill.branchName}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Pill label={BILL_STATUS_LABELS[bill.status]} strong={bill.status === "posted"} testId="document-status" />
              {bill.status === "posted" ? <span className="text-muted-foreground"> A posted bill is never changed.</span> : null}
            </dd>
            {bill.journalId && can(session.role, "journal.read") ? (
              <>
                <dt className="text-muted-foreground">In the books</dt>
                <dd>
                  <Link href={`/journals/${bill.journalId}`} className="underline-offset-4 hover:underline">
                    See the journal
                  </Link>
                </dd>
              </>
            ) : null}
          </dl>
          <div className="overflow-x-auto">
            <table aria-label="Bill lines" className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">For</th>
                  <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                  <th className="py-2 pr-4 font-medium">Unit</th>
                  <th className="py-2 pr-4 text-right font-medium">Price of one</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount</th>
                  <th className="py-2 text-right font-medium">Sales tax</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {bill.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2 pr-4">
                      {line.kind === "goods" ? (
                        <>
                          <span className="font-medium">{line.itemCode}</span> {line.description} <span className="text-muted-foreground">({line.receiptNumber})</span>
                        </>
                      ) : (
                        <>
                          {line.description} <span className="text-muted-foreground">({line.accountName})</span>
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{line.quantity ? formatQuantity(line.quantity) : ""}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{line.unitCode ?? ""}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{line.unitPrice ? price(line.unitPrice) : ""}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(line.amount)}</td>
                    <td className="py-2 text-right tabular-nums">{line.taxRate ? `${formatAmount(line.salesTax)} (${formatPercent(line.taxRate)})` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={bill.status === "posted" ? "What the bill comes to" : "What posting this bill will do"}>
          {bill.status === "posted" ? (
            <>
              <Figures rows={[...totals, ...withheldRows(bill.entries)]} total={["Owed to the supplier", formatAmount(bill.payable)]} />
              {bill.entries.length > 0 ? (
                <ul className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
                  {bill.entries.map((entry) => (
                    <li key={entry.kind}>
                      {WITHHOLDING_KIND_LABELS[entry.kind]}: {entry.legalReference}. The supplier was {entry.onActiveList ? "" : "not "}on the Active Taxpayers List as recorded that day.
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : bill.preview?.ok ? (
            <Figures rows={[...totals, ...withheldRows(bill.preview.figures.withheld)]} total={["Owed to the supplier", formatAmount(bill.preview.figures.payable)]} />
          ) : (
            <p className="text-sm text-muted-foreground">{bill.preview?.reason ?? "Nothing is on the bill yet."}</p>
          )}
        </Card>
      </div>
    </>
  );
}

// ── whether the company withholds tax ───────────────────────────────────────────────────────────

export async function WithholdingScreen() {
  const session = await requireTenant();
  if (!can(session.role, "supplier_bill.read") || !session.modules.purchasing) return <Refused title="Withholding tax">{NO_BILLS}</Refused>;
  const { withholdingOn } = await getPurchaseSettings(session);
  return (
    <>
      <PageHead title="Withholding tax" sub="Whether your company deducts tax from what it pays its suppliers." />
      <Sections session={session} current="/purchases/withholding" />
      <Card className="max-w-2xl">
        <p className="mb-3 text-sm" data-testid="withholding-state">
          {withholdingOn ? "Your company withholds tax from suppliers. A supplier bill can name the withholding lines that apply, and the tax is taken off what is owed to the supplier." : "Your company does not withhold tax from suppliers. Supplier bills are owed in full."}
        </p>
        <p className="mb-4 text-sm text-muted-foreground">
          The law makes some buyers withholding agents: companies, and other businesses above a size. If you are not sure whether yours is one, ask your tax adviser before switching this on. The rates are read from the tax tables under Settings, Tax rates; none is ever typed on a
          bill.
        </p>
        {can(session.role, "supplier_bill.manage") ? (
          <ActionForm action={setWithholdingAction.bind(null, !withholdingOn)} submitLabel={withholdingOn ? "Stop withholding tax" : "Start withholding tax"} compact />
        ) : null}
      </Card>
    </>
  );
}
