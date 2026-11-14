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
import { getDocumentJournal, type Journal } from "@/modules/ledger/queries";
import { getCustomerCredit, getDeliveryRows, getLineDefaults, getOrderDelivery, getSalesDocument, listInvoicesOf, listOrdersToDeliver, listSalesDocuments, listSalesPeople, listSalesWarehouses, type SalesDocument } from "@/modules/sales/queries";
import { KIND_LABELS, KIND_PLURALS, creditRefusal, isEntryKind, isSalesKind, statusLabel, type CreditFacts, type EntryKind, type SalesKind, type SalesStatus } from "@/modules/sales/rules";
import { getCompanySetup } from "@/modules/setup/queries";
import { can } from "@/modules/tenant/rules";
import { approveSalesAction, cancelDeliveryAction, cancelSalesAction, discardSalesAction, orderFromQuotationAction, releaseSalesAction, saveDeliveryAction, saveInvoiceAction, saveSalesAction, startDeliveryAction, startInvoiceAction } from "./actions";
import { DeliveryForm } from "./delivery-form";
import { DocumentOutput } from "./output";
import { SalesForm } from "./sales-form";

const NO_ACCESS = "Your role does not include sales documents.";
const SWITCHED_OFF = "Sales is switched off for this company.";
/** Why this member cannot open the sales screens at all, or null. */
const closed = (session: Session) => (!session.modules.sales ? SWITCHED_OFF : !can(session.role, "sales.read") && !can(session.role, "delivery.read") ? NO_ACCESS : null);
const NO_WRITE = "Your role cannot write sales documents.";
const plainNumber = (amount: Decimal) => amount.toFixed(AMOUNT_SCALE).replace(/\.?0+$/, "");
/** The kind of document a list shows: the one asked for, where this member may see it. The warehouse starts on delivery notes. */
const kindOf = (session: Session, value: string | string[] | undefined): SalesKind => {
  const team = can(session.role, "sales.read");
  if (isSalesKind(value) && (team || (value !== "quotation" && value !== "invoice"))) return value;
  return team ? "order" : "delivery";
};
const entryKindOf = (value: string | string[] | undefined): EntryKind => (isEntryKind(value) ? value : "order");

function StatusPill({ kind, status, testId }: { kind: SalesKind; status: SalesStatus; testId?: string }) {
  const tone = status === "submitted" ? "bg-accent text-accent-foreground" : status === "on_hold" ? "bg-amber-100 text-amber-900" : "bg-muted text-muted-foreground";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ${tone}`}>
      {statusLabel(kind, status)}
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
  const kind = kindOf(session, query.kind);
  const search = typeof query.q === "string" ? query.q : "";
  const [{ rows, more }, toDeliver] = await Promise.all([listSalesDocuments(session, { kind, search }), kind === "delivery" ? listOrdersToDeliver(session) : []]);
  // A delivery note has no total, and the warehouse is not shown what an order sells for.
  const showTotals = kind !== "delivery" && can(session.role, "sales.read");
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
      <PageHead
        title="Sales"
        sub={
          kind === "delivery"
            ? "Delivery notes are made from submitted sales orders. Posting one takes its goods out of stock."
            : kind === "invoice"
              ? "Sales invoices are made from a posted delivery note, or straight from a sales order. Posting one puts it into the books."
              : "Quotations and sales orders. A sales order is checked against the customer's credit limit when it is submitted."
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Kind of document" className="flex gap-1">
          {tab("order")}
          {can(session.role, "sales.read") ? tab("quotation") : null}
          {can(session.role, "delivery.read") ? tab("delivery") : null}
          {can(session.role, "sales.read") ? tab("invoice") : null}
        </nav>
        {isEntryKind(kind) && can(session.role, "sales.manage") ? (
          <Link href={`/sales/new?kind=${kind}`} className={buttonVariants({ className: "ml-auto" })}>
            New {KIND_LABELS[kind].toLowerCase()}
          </Link>
        ) : null}
      </div>
      {kind === "delivery" ? (
        <Card title="Orders waiting to be delivered" className="mb-5 max-w-5xl">
          {toDeliver.length === 0 ? (
            <Empty>No order is waiting to be delivered.</Empty>
          ) : (
            <ul aria-label="Orders waiting to be delivered" className="divide-y text-sm">
              {toDeliver.map((order) => (
                <li key={order.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                  <Link href={`/sales/${order.id}`} className="font-medium underline-offset-4 hover:underline">
                    {order.number}
                  </Link>
                  <span>{order.customerName}</span>
                  <span className="text-muted-foreground">
                    {formatIsoDate(order.date)}, {order.lines} {order.lines === 1 ? "line" : "lines"} to deliver
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
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
                  {showTotals ? <th className="py-2 pr-4 text-right font-medium">Total</th> : null}
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
                    {showTotals ? <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(row.total)}</td> : null}
                    <td className="py-2">
                      <StatusPill kind={row.kind} status={row.status} />
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
  const kind = entryKindOf((await searchParams).kind);
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

/** The lines as written. Without `prices`, for the warehouse: what and how much, nothing of what it sells for. */
function LinesTable({ document, prices = true }: { document: SalesDocument; prices?: boolean }) {
  const { totals, taxed } = document;
  if (!prices) {
    return (
      <div className="overflow-x-auto">
        <table aria-label="Lines" className="w-full min-w-[420px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Item</th>
              <th className="py-2 pr-4 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Quantity</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {document.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                <td className="py-2 pr-4">{line.description}</td>
                <td className="py-2 text-right whitespace-nowrap tabular-nums">
                  {plainNumber(line.quantity)} {line.unitCode}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
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

/** `sales` is false for a reader outside the sales team: who sold it, and any credit approval, are then left out. */
function Facts({ document, team, customerLink, sales = true }: { document: SalesDocument; team: { userId: string; email: string }[]; customerLink: boolean; sales?: boolean }) {
  const person = (userId: string) => team.find((member) => member.userId === userId)?.email ?? "A former member";
  return (
    <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Customer</dt>
      <dd>
        {customerLink ? (
          <Link href={`/customers/${document.customerId}`} className="underline-offset-4 hover:underline">
            {document.customerName}
          </Link>
        ) : (
          document.customerName
        )}
      </dd>
      {document.source ? (
        <>
          <dt className="text-muted-foreground">{KIND_LABELS[document.source.kind]}</dt>
          <dd>
            <Link href={`/sales/${document.source.id}`} className="underline-offset-4 hover:underline">
              {document.source.number}
            </Link>
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Date</dt>
      <dd>{formatIsoDate(document.date)}</dd>
      {document.validUntil ? (
        <>
          <dt className="text-muted-foreground">Valid until</dt>
          <dd>{formatIsoDate(document.validUntil)}</dd>
        </>
      ) : null}
      {document.dueDate ? (
        <>
          <dt className="text-muted-foreground">Due</dt>
          <dd data-testid="due-date">{formatIsoDate(document.dueDate)}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusPill kind={document.kind} status={document.status} testId="document-status" />
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
      {sales && document.shares.length > 0 ? (
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
      {sales && document.creditOverrideReason ? (
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
  // The warehouse reads orders to deliver them: what and how much, not what it sells for.
  const team = can(session.role, "sales.read");
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

  if (document.kind === "delivery") return <DeliveryNote session={session} document={document} back={back} />;
  if (document.kind === "invoice") return <Invoice session={session} document={document} back={back} />;

  if (document.status === "draft" && manager && isEntryKind(document.kind)) {
    const entryKind = document.kind;
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
              action={saveSalesAction.bind(null, document.id, entryKind, loadedAt)}
              kind={entryKind}
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

  const [people, credit, progress] = await Promise.all([
    team ? listSalesPeople(session) : [],
    document.status === "on_hold" ? getCustomerCredit(session, document.customerId, document.id) : null,
    document.kind === "order" && document.status === "submitted" ? getOrderDelivery(session, document.id) : null,
  ]);
  const why = credit ? creditRefusal(credit, document.totals.total) : null;
  const delivered = (progress ?? []).some((line) => line.delivered.gt(0));
  const invoiced = (progress ?? []).some((line) => line.invoiced.gt(0));
  const toDeliver = (progress ?? []).some((line) => line.remaining.gt(0));
  return (
    <>
      {back}
      <PageHead title={document.number ?? (document.status === "on_hold" ? `${label} waiting for approval` : `Draft ${label.toLowerCase()}`)} sub={`${label} for ${document.customerName}`} />
      <div className="flex max-w-5xl flex-col gap-5">
        {linked}
        <Card>
          <Facts document={document} team={people} customerLink={can(session.role, "customer.read")} sales={team} />
          <LinesTable document={document} prices={team} />
        </Card>

        {progress ? (
          <Card title={team ? "Deliveries and invoices" : "Deliveries"}>
            <div className="overflow-x-auto">
              <table aria-label="Deliveries" className="mb-3 w-full min-w-[420px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Item</th>
                    <th className="py-2 pr-4 text-right font-medium">Ordered</th>
                    <th className="py-2 pr-4 text-right font-medium">Delivered</th>
                    <th className="py-2 pr-4 text-right font-medium">Still to deliver</th>
                    {team ? <th className="py-2 text-right font-medium">Invoiced</th> : null}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {progress.map((line) => (
                    <tr key={line.lineNo}>
                      <td className="py-2 pr-4">
                        <span className="font-medium">{line.itemCode}</span> {line.description}
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                        {plainNumber(line.ordered)} {line.unitCode}
                      </td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{plainNumber(line.delivered)}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums" data-testid={`to-deliver-${line.lineNo}`}>
                        {plainNumber(line.remaining)}
                      </td>
                      {team ? (
                        <td className="py-2 text-right whitespace-nowrap tabular-nums" data-testid={`invoiced-${line.lineNo}`}>
                          {plainNumber(line.invoiced)}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!toDeliver ? (
              <p className="text-sm text-muted-foreground">Everything on this order has been delivered. A delivery note is invoiced from its own page.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {can(session.role, "delivery.manage") ? (
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">A delivery note starts with everything still to deliver; bring the quantities down for a part delivery.</p>
                    <ActionForm action={startDeliveryAction.bind(null, document.id)} submitLabel="Make a delivery note" compact />
                  </div>
                ) : null}
                {manager ? (
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">Or invoice straight from the order, with no delivery note: the goods leave stock when the invoice is posted.</p>
                    <ActionForm action={startInvoiceAction.bind(null, document.id)} submitLabel="Invoice and deliver now" compact />
                  </div>
                ) : null}
              </div>
            )}
          </Card>
        ) : null}

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

        {document.status === "submitted" && manager && delivered ? (
          <Card title="Cancel this sales order">
            <p className="text-sm text-muted-foreground">
              {invoiced ? "This order has been invoiced. It can no longer be cancelled." : "Goods have been delivered against this order. To cancel it, cancel its delivery notes first."}
            </p>
          </Card>
        ) : null}
        {document.status === "submitted" && manager && !delivered ? (
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
        <DocumentOutput session={session} document={document} />
      </div>
    </>
  );
}

/** A delivery note: a draft to fill in and post, or a posted or cancelled note to read. No prices: it is a goods document. */
async function DeliveryNote({ session, document, back }: { session: Session; document: NonNullable<Awaited<ReturnType<typeof getSalesDocument>>>; back: React.ReactNode }) {
  const [rows, invoices, journal] = await Promise.all([getDeliveryRows(session, document), listInvoicesOf(session, document.id), document.status === "draft" ? null : getDocumentJournal(session, "delivery_note", document.id)]);
  const writer = can(session.role, "delivery.manage");
  const biller = can(session.role, "sales.manage");
  const billed = invoices.find((invoice) => invoice.status === "submitted");
  const drafted = invoices.find((invoice) => invoice.status === "draft");
  const loadedAt = document.updatedAt.toISOString();
  const order = document.source;
  // Stock is kept in the item's own unit; a line sold by the carton shows how many cartons that is.
  const inUnit = (row: (typeof rows)[number]) => plainNumber(row.onHand.div(row.unitFactor).toDecimalPlaces(4, Decimal.ROUND_DOWN));

  if (document.status === "draft" && writer && order) {
    return (
      <>
        {back}
        <PageHead title="Draft delivery note" sub={`For sales order ${order.number}, ${document.customerName}. Nothing leaves stock until it is posted.`} />
        <div className="flex max-w-5xl flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Goods leave from {document.warehouseName}. Made from{" "}
            <Link href={`/sales/${order.id}`} className="font-medium text-foreground underline underline-offset-4">
              sales order {order.number}
            </Link>
            .
          </p>
          <Card>
            <DeliveryForm
              action={saveDeliveryAction.bind(null, document.id, loadedAt)}
              date={document.date}
              earliest={order.date}
              notes={document.notes ?? ""}
              rows={rows.map((row) => ({
                sourceLineId: row.sourceLineId,
                itemCode: row.itemCode,
                description: row.description,
                unitCode: row.unitCode,
                ordered: plainNumber(row.ordered),
                delivered: plainNumber(row.delivered),
                remaining: plainNumber(Decimal.max(row.ordered.minus(row.delivered), 0)),
                inStock: inUnit(row),
                quantity: row.quantity.isZero() ? "" : plainNumber(row.quantity),
              }))}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number and has moved no stock, so removing it leaves nothing behind.</p>
            <ActionForm action={discardSalesAction.bind(null, document.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const costs = rows.some((row) => row.cost !== null);
  const totalCost = rows.reduce((sum, row) => sum.plus(row.cost ?? 0), new Decimal(0));
  const today = todayIso(new Date());
  return (
    <>
      {back}
      <PageHead title={document.number ?? "Draft delivery note"} sub={`Delivery note for ${document.customerName}`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <Facts document={document} team={[]} customerLink={can(session.role, "customer.read")} sales={false} />
          <div className="overflow-x-auto">
            <table aria-label="Lines" className="w-full min-w-[420px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-4 font-medium">Description</th>
                  <th className="py-2 pr-4 text-right font-medium">Quantity</th>
                  {costs ? <th className="py-2 text-right font-medium">Cost of the goods</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.sourceLineId}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.itemCode}</td>
                    <td className="py-2 pr-4">{row.description}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">
                      {plainNumber(row.quantity)} {row.unitCode}
                    </td>
                    {costs ? <td className="py-2 text-right whitespace-nowrap tabular-nums">{row.cost === null ? "" : formatAmount(row.cost)}</td> : null}
                  </tr>
                ))}
              </tbody>
              {costs ? (
                <tfoot className="border-t font-bold">
                  <tr>
                    <td className="py-2 pr-4 text-right" colSpan={3}>
                      Cost of goods sold
                    </td>
                    <td className="py-2 text-right whitespace-nowrap tabular-nums" data-testid="delivery-cost">
                      {formatAmount(totalCost)}
                    </td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
        </Card>
        {document.status === "submitted" && (billed || biller) ? (
          <Card title="Invoice">
            {billed ? (
              <p className="text-sm">
                Invoiced on{" "}
                <Link href={`/sales/${billed.id}`} className="font-medium underline underline-offset-4">
                  {billed.number}
                </Link>
                .
              </p>
            ) : (
              <>
                <p className="mb-3 text-sm text-muted-foreground">
                  {drafted ? "A draft invoice for this delivery note is waiting to be posted." : "Not invoiced yet. The invoice bills exactly what this note delivered, with the tax worked out for the invoice's own date."}
                </p>
                <ActionForm action={startInvoiceAction.bind(null, document.id)} submitLabel={drafted ? "Open the draft invoice" : "Make a sales invoice"} compact />
              </>
            )}
          </Card>
        ) : null}
        {journal ? <Books journal={journal} /> : null}
        {document.status === "submitted" && writer && billed ? (
          <Card title="Cancel this delivery note">
            <p className="text-sm text-muted-foreground">This delivery note has been invoiced. It can no longer be cancelled.</p>
          </Card>
        ) : null}
        {document.status === "submitted" && writer && !billed ? (
          <Card title="Cancel this delivery note">
            <p className="mb-3 text-sm text-muted-foreground">
              A posted delivery note is never changed. Cancelling it puts its goods back into stock at what they went out at and reverses its entry in the books, on the date you
              choose. The order can then be delivered again.
            </p>
            <ActionForm action={cancelDeliveryAction.bind(null, document.id, loadedAt)} submitLabel="Cancel delivery note">
              <Field label="Date the goods came back" name="date" type="date" defaultValue={today < document.date ? document.date : today} min={document.date} required className="max-w-[12rem]" />
              <Field label="Why it is cancelled" name="reason" maxLength={300} autoComplete="off" required className="max-w-xl" />
            </ActionForm>
          </Card>
        ) : null}
        <DocumentOutput session={session} document={document} />
      </div>
    </>
  );
}

/** What a document put into the books: its journal, for those who read the ledger. */
function Books({ journal }: { journal: Journal }) {
  const total = journal.lines.reduce((sum, line) => sum.plus(line.debit), new Decimal(0));
  return (
    <Card title="In the books">
      <div className="overflow-x-auto">
        <table aria-label="In the books" className="w-full min-w-[420px] text-left text-sm">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">Account</th>
              <th className="py-2 pr-4 text-right font-medium">Debit</th>
              <th className="py-2 text-right font-medium">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {journal.lines.map((line) => (
              <tr key={line.lineNo}>
                <td className="py-2 pr-4">
                  <span className="font-medium tabular-nums">{line.accountCode}</span> {line.accountName}
                </td>
                <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{line.debit.isZero() ? "" : formatAmount(line.debit)}</td>
                <td className="py-2 text-right whitespace-nowrap tabular-nums">{line.credit.isZero() ? "" : formatAmount(line.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t font-bold">
            <tr>
              <td className="py-2 pr-4">Total</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap tabular-nums">{formatAmount(total)}</td>
              <td className="py-2 text-right whitespace-nowrap tabular-nums">{formatAmount(total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

/** A sales invoice: a draft to check and post, or a posted invoice to read, with what it put into the books. */
async function Invoice({ session, document, back }: { session: Session; document: NonNullable<Awaited<ReturnType<typeof getSalesDocument>>>; back: React.ReactNode }) {
  const manager = can(session.role, "sales.manage");
  const loadedAt = document.updatedAt.toISOString();
  const source = document.source;
  const direct = source?.kind === "order";

  if (document.status === "draft" && manager && source) {
    // Made straight from an order, the quantities can be brought down; made from a delivery note, it bills the whole note.
    const rows = direct ? await getDeliveryRows(session, document) : [];
    return (
      <>
        {back}
        <PageHead title="Draft sales invoice" sub={`For ${document.customerName}. Nothing reaches the books until it is posted.`} />
        <div className="flex max-w-5xl flex-col gap-5">
          <p className="text-sm text-muted-foreground">
            Made from{" "}
            <Link href={`/sales/${source.id}`} className="font-medium text-foreground underline underline-offset-4">
              {KIND_LABELS[source.kind].toLowerCase()} {source.number}
            </Link>
            . {direct ? `The goods leave ${document.warehouseName} when the invoice is posted.` : "It bills exactly what that note delivered."}
          </p>
          <Card>
            <DeliveryForm
              action={saveInvoiceAction.bind(null, document.id, loadedAt)}
              date={document.date}
              earliest={source.date}
              notes={document.notes ?? ""}
              words={{ date: "Date of invoice", quantity: "Invoice now", post: "Post invoice", notes: "Anything to say to the customer" }}
              rows={rows.map((row) => ({
                sourceLineId: row.sourceLineId,
                itemCode: row.itemCode,
                description: row.description,
                unitCode: row.unitCode,
                ordered: plainNumber(row.ordered),
                delivered: plainNumber(row.delivered),
                remaining: plainNumber(Decimal.max(row.ordered.minus(row.delivered), 0)),
                inStock: plainNumber(row.onHand.div(row.unitFactor).toDecimalPlaces(4, Decimal.ROUND_DOWN)),
                quantity: row.quantity.isZero() ? "" : plainNumber(row.quantity),
              }))}
            />
          </Card>
          {document.lines.length > 0 ? (
            <Card title="As saved">
              <LinesTable document={document} />
            </Card>
          ) : null}
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number and is not in the books, so removing it leaves nothing behind.</p>
            <ActionForm action={discardSalesAction.bind(null, document.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const [people, journal] = await Promise.all([listSalesPeople(session), document.status === "draft" ? null : getDocumentJournal(session, "sales_invoice", document.id)]);
  return (
    <>
      {back}
      <PageHead title={document.number ?? "Draft sales invoice"} sub={`Sales invoice for ${document.customerName}`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <Facts document={document} team={people} customerLink={can(session.role, "customer.read")} />
          <LinesTable document={document} />
        </Card>
        {journal ? <Books journal={journal} /> : null}
        {document.status === "submitted" ? (
          <p className="text-sm text-muted-foreground">A posted invoice is never changed or cancelled. A mistake on it is put right with a credit note, which comes with sales returns.</p>
        ) : null}
        <DocumentOutput session={session} document={document} />
      </div>
    </>
  );
}
