import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { AMOUNT_SCALE, formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { submitProblem } from "@/modules/sales/commands";
import { getCustomerCredit, getLineDefaults, getSalesDocument, listSalesDocuments, listSalesPeople, listSalesWarehouses, type SalesDocument } from "@/modules/sales/queries";
import { KIND_LABELS, KIND_PLURALS, STATUS_LABELS, creditRefusal, isSalesKind, type CreditFacts, type SalesKind, type SalesStatus } from "@/modules/sales/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { can } from "@/modules/tenant/rules";
import { approveSalesAction, cancelSalesAction, discardSalesAction, orderFromQuotationAction, releaseSalesAction, saveSalesAction } from "./actions";
import { SalesForm } from "./sales-form";

const NO_ACCESS = "Your role does not include sales documents.";
const SWITCHED_OFF = "Sales is switched off for this company.";
/** Why this member cannot open the sales screens at all, or null. */
const closed = (session: Session) => (!session.modules.sales ? SWITCHED_OFF : !can(session.role, "sales.read") ? NO_ACCESS : null);
const NO_WRITE = "Your role cannot write sales documents.";
const plainNumber = (amount: Decimal) => amount.toFixed(AMOUNT_SCALE).replace(/\.?0+$/, "");
const kindOf = (value: string | string[] | undefined): SalesKind => (isSalesKind(value) ? value : "order");

function StatusPill({ status, testId }: { status: SalesStatus; testId?: string }) {
  const tone = status === "submitted" ? "bg-accent text-accent-foreground" : status === "on_hold" ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${tone}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

export async function SalesListScreen({ searchParams }: { searchParams: Promise<{ kind?: string | string[]; q?: string | string[] }> }) {
  const session = await requireTenant();
  const refused = closed(session);
  if (refused) {
    return (
      <>
        <PageHead title="Sales" />
        <p className="text-muted-foreground">{refused}</p>
      </>
    );
  }
  const query = await searchParams;
  const kind = kindOf(query.kind);
  const search = typeof query.q === "string" ? query.q : "";
  const { rows, more } = await listSalesDocuments(session, { kind, search });
  const tab = (other: SalesKind) => (
    <Link
      href={`/sales?kind=${other}`}
      aria-current={other === kind ? "page" : undefined}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${other === kind ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}
    >
      {KIND_PLURALS[other]}
    </Link>
  );
  return (
    <>
      <PageHead title="Sales" sub="Quotations and sales orders. A sales order is checked against the customer's credit limit when it is submitted." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Kind of document" className="flex gap-1">
          {tab("order")}
          {tab("quotation")}
        </nav>
        {can(session.role, "sales.manage") ? (
          <Link href={`/sales/new?kind=${kind}`} className={buttonVariants({ className: "ml-auto" })}>
            New {KIND_LABELS[kind].toLowerCase()}
          </Link>
        ) : null}
      </div>
      <Card className="max-w-5xl">
        <form className="mb-3 flex max-w-sm gap-2" role="search">
          <input type="hidden" name="kind" value={kind} />
          <Input name="q" defaultValue={search} placeholder="Find by number or customer" aria-label="Find by number or customer" />
          <button type="submit" className={buttonVariants({ variant: "outline" })}>
            Find
          </button>
        </form>
        {rows.length === 0 ? (
          <Empty>{search === "" ? `No ${KIND_PLURALS[kind].toLowerCase()} yet.` : "Nothing matches."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label={KIND_PLURALS[kind]} className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 text-right font-medium">Total</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/sales/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.customerName}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.total)}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200. Use the box above to find an older one.</p> : null}
      </Card>
    </>
  );
}

type Session = Awaited<ReturnType<typeof requireTenant>>;
const creditForForm = (credit: CreditFacts | null) => (credit === null ? null : { limit: credit.limit?.toFixed(AMOUNT_SCALE) ?? null, receivable: credit.receivable.toFixed(AMOUNT_SCALE), openOrders: credit.openOrders.toFixed(AMOUNT_SCALE) });

/** What the form needs besides the document: the company's tax answers, the warehouses and the sales team. */
async function formChoices(session: Session) {
  const [setup, warehouses, salesPeople] = await Promise.all([getCompanySetup(session), listSalesWarehouses(session), listSalesPeople(session)]);
  const taxed = setup?.salesTaxRegistered ?? false;
  return { taxed, pricesIncludeTax: taxed && (setup?.pricesIncludeTax ?? false), warehouses: warehouses.map((w) => ({ id: w.id, name: w.name })), salesPeople: salesPeople.map((p) => ({ userId: p.userId, email: p.email })), team: salesPeople };
}

function NoWarehouse() {
  return <p className="text-muted-foreground">This company has no warehouse you can sell from yet. An owner adds one under Settings.</p>;
}

export async function NewSalesScreen({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const session = await requireTenant();
  const kind = kindOf((await searchParams).kind);
  const title = `New ${KIND_LABELS[kind].toLowerCase()}`;
  if (closed(session) || !can(session.role, "sales.manage")) {
    return (
      <>
        <PageHead title={title} />
        <p className="text-muted-foreground">{closed(session) ?? NO_WRITE}</p>
      </>
    );
  }
  const choices = await formChoices(session);
  // A sale written by someone on the sales team is theirs unless they say otherwise.
  const mine = session.role !== "owner" && choices.team.some((person) => person.userId === session.userId);
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href={`/sales?kind=${kind}`} className="text-muted-foreground underline-offset-4 hover:underline">
          {KIND_PLURALS[kind]}
        </Link>
      </p>
      <PageHead title={title} />
      {choices.warehouses.length === 0 ? (
        <NoWarehouse />
      ) : (
        <Card className="max-w-5xl">
          <SalesForm
            action={saveSalesAction.bind(null, null, kind, "")}
            kind={kind}
            taxed={choices.taxed}
            pricesIncludeTax={choices.pricesIncludeTax}
            warehouses={choices.warehouses}
            salesPeople={choices.salesPeople}
            documentId={null}
            credit={null}
            initial={{ date: todayIso(new Date()), validUntil: "", customer: null, warehouseId: choices.warehouses[0].id, customerReference: "", notes: "", furtherTaxExcluded: false, lines: [], shares: mine ? [{ userId: session.userId, percent: "100" }] : [] }}
          />
        </Card>
      )}
    </>
  );
}

function LinesTable({ document }: { document: SalesDocument }) {
  const { totals, taxed } = document;
  const hasDiscount = !totals.discount.isZero();
  const span = 4 + (hasDiscount ? 1 : 0);
  const sum = (label: string, amount: Decimal, testId?: string, strong = false) => (
    <tr className={strong ? "font-bold" : undefined}>
      <td className="py-1 pr-4 text-right" colSpan={span}>
        {label}
      </td>
      <td className="py-1 text-right whitespace-nowrap tabular-nums" data-testid={testId}>
        {formatAmount(amount)}
      </td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table aria-label="Lines" className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 font-medium">Description</th>
            <th className="py-2 pr-4 text-right font-medium">Quantity</th>
            <th className="py-2 pr-4 text-right font-medium">Price</th>
            {hasDiscount ? <th className="py-2 pr-4 text-right font-medium">Discount</th> : null}
            <th className="py-2 text-right font-medium">{taxed && !document.pricesIncludeTax ? "Amount before tax" : "Amount"}</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {document.lines.map((line) => (
            <tr key={line.id}>
              <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
              <td className="py-2 pr-4">
                {line.description}
                {taxed && line.taxKind ? (
                  <span className="block text-xs text-muted-foreground">
                    {line.taxKind === "exempt" ? "Exempt from sales tax" : `Sales tax ${line.taxRate.toFixed()}%: ${formatAmount(line.taxAmount)}`}
                    {line.furtherTaxAmount.isZero()
                      ? ""
                      : `, further tax ${line.furtherTaxRate.toFixed()}%: ${formatAmount(line.furtherTaxAmount)}${line.furtherTaxReason === "buyer_not_checked" ? " (the customer's active-taxpayer status has not been checked)" : ""}`}
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                {plainNumber(line.quantity)} {line.unitCode}
              </td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                {formatAmount(line.unitPrice)}
                {line.listPrice !== null && !line.listPrice.eq(line.unitPrice) ? <span className="block text-xs text-muted-foreground">List {formatAmount(line.listPrice)}</span> : null}
              </td>
              {hasDiscount ? (
                <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{line.discountPercent === null ? "" : `${line.discountPercent.toFixed()}%`}</td>
              ) : null}
              <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(taxed && !document.pricesIncludeTax ? line.value : line.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t">
          {taxed ? sum(document.pricesIncludeTax ? "Value before sales tax" : "Total before sales tax", totals.value) : null}
          {taxed ? sum("Sales tax", totals.tax, "total-tax") : null}
          {taxed && !totals.furtherTax.isZero() ? sum("Further tax", totals.furtherTax, "total-further-tax") : null}
          {sum(`Total (${document.currency})`, totals.total, "document-total", true)}
        </tfoot>
      </table>
    </div>
  );
}

function Facts({ document, team }: { document: SalesDocument; team: { userId: string; email: string }[] }) {
  const person = (userId: string) => team.find((member) => member.userId === userId)?.email ?? "A former member";
  return (
    <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Customer</dt>
      <dd>
        <Link href={`/customers/${document.customerId}`} className="underline-offset-4 hover:underline">
          {document.customerName}
        </Link>
      </dd>
      <dt className="text-muted-foreground">Date</dt>
      <dd>{formatIsoDate(document.date)}</dd>
      {document.validUntil ? (
        <>
          <dt className="text-muted-foreground">Valid until</dt>
          <dd>{formatIsoDate(document.validUntil)}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusPill status={document.status} testId="document-status" />
        {document.status === "cancelled" && document.cancelReason ? <span className="text-muted-foreground"> {document.cancelReason}</span> : null}
      </dd>
      <dt className="text-muted-foreground">Goods leave from</dt>
      <dd>{document.warehouseName}</dd>
      {document.customerReference ? (
        <>
          <dt className="text-muted-foreground">Customer&apos;s reference</dt>
          <dd>{document.customerReference}</dd>
        </>
      ) : null}
      {document.shares.length > 0 ? (
        <>
          <dt className="text-muted-foreground">Salespeople</dt>
          <dd>{document.shares.map((share) => `${person(share.userId)}${document.shares.length > 1 ? ` ${share.percent.toFixed()}%` : ""}`).join(", ")}</dd>
        </>
      ) : null}
      {document.notes ? (
        <>
          <dt className="text-muted-foreground">Notes</dt>
          <dd>{document.notes}</dd>
        </>
      ) : null}
      {document.creditOverrideReason ? (
        <>
          <dt className="text-muted-foreground">Over the credit limit</dt>
          <dd data-testid="override-reason">Approved by the owner: {document.creditOverrideReason}</dd>
        </>
      ) : null}
    </dl>
  );
}

export async function SalesDocumentScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  const shut = closed(session);
  if (shut) {
    return (
      <>
        <PageHead title="Sales document" />
        <p className="text-muted-foreground">{shut}</p>
      </>
    );
  }
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const document = await getSalesDocument(session, id);
  if (!document) notFound();
  const manager = can(session.role, "sales.manage");
  const approver = can(session.role, "sales.approve_credit");
  const loadedAt = document.updatedAt.toISOString();
  const label = KIND_LABELS[document.kind];
  const back = (
    <p className="mb-2 text-sm">
      <Link href={`/sales?kind=${document.kind}`} className="text-muted-foreground underline-offset-4 hover:underline">
        {KIND_PLURALS[document.kind]}
      </Link>
    </p>
  );
  const linked = (
    <>
      {document.madeFrom.map((from) => (
        <p key={from.id} className="text-sm text-muted-foreground">
          Made from{" "}
          <Link href={`/sales/${from.id}`} className="font-medium text-foreground underline underline-offset-4">
            {KIND_LABELS[from.kind].toLowerCase()} {from.number ?? "(draft)"}
          </Link>
          .
        </p>
      ))}
      {document.madeInto.map((into) => (
        <p key={into.id} className="text-sm text-muted-foreground">
          {KIND_LABELS[into.kind]}{" "}
          <Link href={`/sales/${into.id}`} className="font-medium text-foreground underline underline-offset-4">
            {into.number ?? "(draft)"}
          </Link>{" "}
          was made from this.
        </p>
      ))}
    </>
  );

  if (document.status === "draft" && manager) {
    const wasRefused = typeof refused === "string" && refused !== "";
    const [choices, credit, problem, defaults] = await Promise.all([
      formChoices(session),
      document.kind === "order" ? getCustomerCredit(session, document.customerId, document.id) : null,
      wasRefused ? submitProblem(session, document.id) : null,
      // Each line's units and the customer's list price, so a unit or a price can still be changed.
      Promise.all(document.lines.map((line) => getLineDefaults(session, { itemId: line.itemId, customerId: document.customerId, date: document.date }))),
    ]);
    const warehouses = choices.warehouses.some((w) => w.id === document.warehouseId) ? choices.warehouses : [...choices.warehouses, { id: document.warehouseId, name: document.warehouseName }];
    return (
      <>
        {back}
        <PageHead title={`Draft ${label.toLowerCase()}`} sub="Not submitted yet. It gets its number when it is submitted." />
        <div className="flex max-w-5xl flex-col gap-5">
          {linked}
          <Card>
            <SalesForm
              action={saveSalesAction.bind(null, document.id, document.kind, loadedAt)}
              kind={document.kind}
              taxed={choices.taxed}
              pricesIncludeTax={choices.pricesIncludeTax}
              warehouses={warehouses}
              salesPeople={choices.salesPeople}
              documentId={document.id}
              credit={creditForForm(credit)}
              refused={wasRefused ? (problem?.needsReason ? problem.message : `Saved as a draft, but not submitted. ${problem?.message ?? "Submit it again to see why."}`) : undefined}
              needsReason={problem?.needsReason ?? false}
              initial={{
                date: document.date,
                validUntil: document.validUntil ?? "",
                customer: { id: document.customerId, label: document.customerName },
                warehouseId: document.warehouseId,
                customerReference: document.customerReference ?? "",
                notes: document.notes ?? "",
                furtherTaxExcluded: document.furtherTaxExcluded,
                lines: document.lines.map((line, index) => ({
                  item: { id: line.itemId, label: line.itemCode, sub: line.description },
                  name: line.description,
                  units: defaults[index]?.units ?? [{ id: line.unitId, code: line.unitCode, factor: line.unitFactor.toFixed() }],
                  unitId: line.unitId,
                  quantity: plainNumber(line.quantity),
                  unitPrice: plainNumber(line.unitPrice),
                  // A line saved at the price lists' own price was not typed; anything else was.
                  priceTyped: line.listPrice === null || !line.listPrice.eq(line.unitPrice),
                  listPrice: defaults[index]?.listPrice ?? null,
                  discountPercent: line.discountPercent === null ? "" : line.discountPercent.toFixed(),
                })),
                shares: document.shares.map((share) => ({ userId: share.userId, percent: share.percent.toFixed() })),
              }}
            />
          </Card>
          {document.lines.length > 0 ? (
            <Card title="As saved">
              <LinesTable document={document} />
            </Card>
          ) : null}
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardSalesAction.bind(null, document.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const [team, credit] = await Promise.all([listSalesPeople(session), document.status === "on_hold" ? getCustomerCredit(session, document.customerId, document.id) : null]);
  const why = credit ? creditRefusal(credit, document.totals.total) : null;
  return (
    <>
      {back}
      <PageHead title={document.number ?? (document.status === "on_hold" ? `${label} waiting for approval` : `Draft ${label.toLowerCase()}`)} sub={`${label} for ${document.customerName}`} />
      <div className="flex max-w-5xl flex-col gap-5">
        {linked}
        <Card>
          <Facts document={document} team={team} />
          <LinesTable document={document} />
        </Card>

        {document.status === "on_hold" ? (
          <Card title="Waiting for the owner's approval">
            <p className="mb-3 text-sm" data-testid="hold-reason">
              {why ?? "This order was over the customer's credit limit when it was written. It is back under the limit now: the owner can let it through, or it can be taken back to a draft and submitted again."}
            </p>
            <div className="flex flex-col gap-4">
              {approver ? (
                <ActionForm action={approveSalesAction.bind(null, document.id, loadedAt)} submitLabel="Approve and submit order">
                  <Field label="Reason for approving it over the credit limit" name="reason" maxLength={300} autoComplete="off" placeholder="Such as: cheque due on Monday" className="max-w-xl" />
                </ActionForm>
              ) : null}
              {manager ? (
                <div>
                  <p className="mb-2 text-sm text-muted-foreground">{approver ? "Or send it back so it can be changed:" : "To change the order, take it back to a draft:"}</p>
                  <ActionForm action={releaseSalesAction.bind(null, document.id, loadedAt)} submitLabel={approver ? "Send back to draft" : "Take back to draft"} compact />
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        {document.status === "submitted" && document.kind === "quotation" && manager ? (
          <Card title="Make a sales order">
            <p className="mb-3 text-sm text-muted-foreground">Starts a draft sales order with this quotation&apos;s lines, prices and discounts, dated today.</p>
            <ActionForm action={orderFromQuotationAction.bind(null, document.id, loadedAt)} submitLabel="Make a sales order" compact />
          </Card>
        ) : null}

        {document.status === "submitted" && manager ? (
          <Card title={`Cancel this ${label.toLowerCase()}`}>
            <p className="mb-3 text-sm text-muted-foreground">
              A submitted {label.toLowerCase()} is never changed. Cancelling keeps it, with its number, marked as cancelled
              {document.kind === "order" ? ", and gives the customer's credit room back" : ""}.
            </p>
            <ActionForm action={cancelSalesAction.bind(null, document.id, loadedAt)} submitLabel={`Cancel ${label.toLowerCase()}`}>
              <Field label="Why it is cancelled" name="reason" maxLength={300} autoComplete="off" required className="max-w-xl" />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
