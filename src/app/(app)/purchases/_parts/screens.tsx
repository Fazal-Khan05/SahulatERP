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
import { formatQuantity } from "@/modules/inventory/rules";
import { getGrni, getOrder, getOrderChoices, getOrderToReceive, getReceipt, listOrders, listOrdersToReceive, listReceipts } from "@/modules/purchasing/queries";
import { ORDER_STATUS_LABELS, RECEIPT_STATUS_LABELS, UNIT_COST_SCALE, stillToReceive, type OrderLineToReceive } from "@/modules/purchasing/rules";
import { can, type Permission } from "@/modules/tenant/rules";
import { cancelOrderAction, discardOrderAction, discardReceiptAction, saveOrderAction, saveReceiptAction } from "./actions";
import { OrderForm } from "./order-form";
import { ReceiptForm } from "./receipt-form";

export function Pill({ label, strong, testId }: { label: string; strong: boolean; testId?: string }) {
  const tone = strong ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {label}
    </span>
  );
}

export function Refused({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{children}</p>
    </>
  );
}

const SECTIONS: readonly { href: string; label: string; permission: Permission }[] = [
  { href: "/purchases", label: "Purchase orders", permission: "purchase_order.read" },
  { href: "/purchases/receive", label: "Receive goods", permission: "goods_receipt.read" },
  { href: "/purchases/bills", label: "Supplier bills", permission: "supplier_bill.read" },
  { href: "/purchases/grni", label: "Goods received, not yet billed", permission: "purchase_order.read" },
  { href: "/purchases/withholding", label: "Withholding tax", permission: "supplier_bill.read" },
];

/** The buying screens this role may open, as a row of links above each of them. */
export function Sections({ session, current }: { session: TenantSession; current: string }) {
  const open = SECTIONS.filter((section) => can(session.role, section.permission));
  if (open.length < 2) return null;
  return (
    <nav aria-label="Purchases" className="mb-4 flex flex-wrap gap-x-5 gap-y-1 border-b pb-2 text-sm">
      {open.map((section) =>
        section.href === current ? (
          <span key={section.href} aria-current="page" className="font-semibold">
            {section.label}
          </span>
        ) : (
          <Link key={section.href} href={section.href} className="text-muted-foreground underline-offset-4 hover:underline">
            {section.label}
          </Link>
        ),
      )}
    </nav>
  );
}

export function Back({ href, label }: { href: string; label: string }) {
  return (
    <p className="mb-2 text-sm">
      <Link href={href} className="text-muted-foreground underline-offset-4 hover:underline">
        {label}
      </Link>
    </p>
  );
}

/** What one costs: as an amount, or with the third and fourth decimals it was typed with. */
const cost = (value: Decimal) => (value.decimalPlaces() <= 2 ? formatAmount(value) : value.toFixed(Math.min(value.decimalPlaces(), UNIT_COST_SCALE)));
const NO_ORDERS = "Only an owner, an accountant or an auditor can see purchase orders. The warehouse receives goods under Receive goods.";
const NO_RECEIPTS = "Your role does not include goods received.";
const refusedNote = (refused: string | string[] | undefined, word: string) => (typeof refused === "string" && refused !== "" ? `Saved as a draft, but not ${word}. Try again to see why.` : undefined);

// ── purchase orders ─────────────────────────────────────────────────────────────────────────────

export async function OrdersScreen() {
  const session = await requireTenant();
  if (!can(session.role, "purchase_order.read") || !session.modules.purchasing) return <Refused title="Purchase orders">{NO_ORDERS}</Refused>;
  const { rows, more } = await listOrders(session);
  return (
    <>
      <PageHead title="Purchase orders" sub="What has been ordered from suppliers. Nothing reaches the books or the stock until the goods are received." />
      <Sections session={session} current="/purchases" />
      {can(session.role, "purchase_order.manage") ? (
        <p className="mb-4">
          <Link href="/purchases/new" className={buttonVariants()}>
            New purchase order
          </Link>
        </p>
      ) : null}
      <Card className="max-w-5xl">
        {rows.length === 0 ? (
          <Empty>No purchase orders yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Purchase orders" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Warehouse</th>
                  <th className="py-2 pr-4 text-right font-medium">Total before tax</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/purchases/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.supplierName}</td>
                    <td className="py-2 pr-4">{row.warehouseName}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(row.total)}</td>
                    <td className="py-2">
                      <Pill label={ORDER_STATUS_LABELS[row.status]} strong={row.status === "submitted"} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 orders.</p> : null}
      </Card>
    </>
  );
}

function NothingToOrderFrom({ suppliers, warehouses, items }: { suppliers: number; warehouses: number; items: number }) {
  const missing = [suppliers === 0 ? "a supplier (under Suppliers)" : null, warehouses === 0 ? "a warehouse (under Settings, Branches)" : null, items === 0 ? "an item (under Items)" : null].filter(Boolean);
  return <p className="text-muted-foreground">An order names a supplier, a warehouse and items. Add {missing.join(" and ")} first.</p>;
}

export async function NewOrderScreen() {
  const session = await requireTenant();
  if (!can(session.role, "purchase_order.manage") || !session.modules.purchasing) return <Refused title="New purchase order">Only an owner or an accountant can write purchase orders.</Refused>;
  const choices = await getOrderChoices(session);
  const ready = choices.suppliers.length > 0 && choices.warehouses.length > 0 && choices.items.length > 0;
  return (
    <>
      <Back href="/purchases" label="Purchase orders" />
      <PageHead title="New purchase order" sub="It gets its number when it is submitted. Goods are then received against it." />
      {ready ? (
        <Card className="max-w-5xl">
          <OrderForm
            action={saveOrderAction.bind(null, null, "")}
            {...choices}
            initial={{ date: todayIso(new Date()), supplierId: "", warehouseId: choices.warehouses.length === 1 ? choices.warehouses[0].id : "", expectedOn: "", supplierReference: "", note: "", lines: [] }}
          />
        </Card>
      ) : (
        <NothingToOrderFrom suppliers={choices.suppliers.length} warehouses={choices.warehouses.length} items={choices.items.length} />
      )}
    </>
  );
}

export async function OrderScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "purchase_order.read") || !session.modules.purchasing) return <Refused title="Purchase order">{NO_ORDERS}</Refused>;
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const order = await getOrder(session, id);
  if (!order) notFound();
  const loadedAt = order.updatedAt.toISOString();
  const back = <Back href="/purchases" label="Purchase orders" />;
  const manage = can(session.role, "purchase_order.manage");

  if (order.status === "draft" && manage) {
    const choices = await getOrderChoices(session);
    // A supplier archived since the draft was written is still shown, so the draft opens as it was saved.
    const suppliers = choices.suppliers.some((supplier) => supplier.id === order.supplierId) ? choices.suppliers : [...choices.suppliers, { id: order.supplierId, label: `${order.supplierName} (archived)` }];
    return (
      <>
        {back}
        <PageHead title="Draft purchase order" sub="Nothing has been ordered yet. It gets its number when it is submitted." />
        <div className="flex max-w-5xl flex-col gap-5">
          <Card>
            <OrderForm
              action={saveOrderAction.bind(null, order.id, loadedAt)}
              {...choices}
              suppliers={suppliers}
              initial={{
                date: order.date,
                supplierId: order.supplierId,
                warehouseId: order.warehouseId,
                expectedOn: order.expectedOn ?? "",
                supplierReference: order.supplierReference ?? "",
                note: order.note ?? "",
                lines: order.lines.map((line) => ({ itemCode: line.itemCode, unitId: line.unitId, quantity: formatQuantity(line.quantity), unitCost: line.unitCost.toFixed() })),
              }}
              refused={refusedNote(refused, "submitted")}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardOrderAction.bind(null, order.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const arrived = new Map(order.toReceive.map((line) => [line.lineId, line]));
  const left = order.toReceive.some((line) => stillToReceive(line).gt(0));
  const draftNote = order.receipts.find((receipt) => receipt.status === "draft");
  const receive = order.status === "submitted" && can(session.role, "goods_receipt.manage");
  return (
    <>
      {back}
      <PageHead title={order.number ?? "Draft purchase order"} sub={order.note ?? undefined} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Date</dt>
            <dd>{formatIsoDate(order.date)}</dd>
            <dt className="text-muted-foreground">Supplier</dt>
            <dd>
              <Link href={`/suppliers/${order.supplierId}`} className="underline-offset-4 hover:underline">
                {order.supplierName}
              </Link>
            </dd>
            <dt className="text-muted-foreground">Warehouse</dt>
            <dd>{order.warehouseName}</dd>
            {order.expectedOn ? (
              <>
                <dt className="text-muted-foreground">Expected on</dt>
                <dd>{formatIsoDate(order.expectedOn)}</dd>
              </>
            ) : null}
            {order.supplierReference ? (
              <>
                <dt className="text-muted-foreground">Supplier&apos;s reference</dt>
                <dd>{order.supplierReference}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <Pill label={ORDER_STATUS_LABELS[order.status]} strong={order.status === "submitted"} testId="document-status" />
              {order.status === "submitted" ? <span className="text-muted-foreground"> {left ? "Goods are still to arrive." : "Everything ordered has arrived."}</span> : null}
              {order.status === "cancelled" && order.cancelReason ? <span className="text-muted-foreground"> {order.cancelReason}</span> : null}
            </dd>
          </dl>
          <div className="overflow-x-auto">
            <table aria-label="Order lines" className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Item code</th>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-2 text-right font-medium">Ordered</th>
                  {order.status === "submitted" ? <th className="py-2 pr-2 text-right font-medium">Arrived</th> : null}
                  <th className="py-2 pr-4 font-medium">Unit</th>
                  <th className="py-2 pr-4 text-right font-medium">Cost of one</th>
                  <th className="py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {order.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                    <td className="py-2 pr-4">{line.description}</td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(line.quantity)}</td>
                    {order.status === "submitted" ? <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(arrived.get(line.id)?.received ?? new Decimal(0))}</td> : null}
                    <td className="py-2 pr-4 text-muted-foreground">{line.unitCode}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{cost(line.unitCost)}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(line.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t">
                <tr>
                  <td colSpan={order.status === "submitted" ? 6 : 5} className="py-2 pr-4 text-right font-medium">
                    Total before tax
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums" data-testid="order-total">
                    {formatAmount(order.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>

        {order.status === "submitted" ? (
          <Card title="Goods received">
            {order.receipts.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing has been received against this order yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {order.receipts.map((receipt) => (
                  <li key={receipt.id}>
                    <Link href={`/purchases/receipts/${receipt.id}`} className="font-medium underline-offset-4 hover:underline">
                      {receipt.number ?? "Draft goods received note"}
                    </Link>{" "}
                    <span className="text-muted-foreground">{formatIsoDate(receipt.date)}</span>
                  </li>
                ))}
              </ul>
            )}
            {receive && left && !draftNote ? (
              <p className="mt-3">
                <Link href={`/purchases/receive/${order.id}`} className={buttonVariants({ size: "sm" })}>
                  Receive goods
                </Link>
              </p>
            ) : null}
          </Card>
        ) : null}

        {order.status === "submitted" && manage && order.receipts.length === 0 ? (
          <Card title="Cancel this order">
            <p className="mb-3 text-sm text-muted-foreground">An order can be cancelled while nothing has been received against it. It keeps its number and stays on the list, marked cancelled, with the reason.</p>
            <ActionForm action={cancelOrderAction.bind(null, order.id, loadedAt)} submitLabel="Cancel order" className="max-w-md">
              <Field label="Reason" name="reason" required maxLength={300} autoComplete="off" placeholder="Such as: supplier out of stock" />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── goods received ──────────────────────────────────────────────────────────────────────────────

export async function ReceiveScreen() {
  const session = await requireTenant();
  if (!can(session.role, "goods_receipt.read") || !session.modules.purchasing) return <Refused title="Receive goods">{NO_RECEIPTS}</Refused>;
  const [orders, { rows, more }] = await Promise.all([listOrdersToReceive(session), listReceipts(session)]);
  const manage = can(session.role, "goods_receipt.manage");
  return (
    <>
      <PageHead title="Receive goods" sub="Goods arrive against a purchase order. They are in the warehouse, and in the books, as soon as the note is posted." />
      <Sections session={session} current="/purchases/receive" />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card title="Orders with goods still to arrive">
          {orders.length === 0 ? (
            <Empty>No order is waiting for goods.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Orders with goods still to arrive" className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Order</th>
                    <th className="py-2 pr-4 font-medium">Ordered on</th>
                    <th className="py-2 pr-4 font-medium">Expected on</th>
                    <th className="py-2 pr-4 font-medium">Supplier</th>
                    <th className="py-2 pr-4 font-medium">Warehouse</th>
                    <th className="py-2 pr-4 text-right font-medium">Lines to come</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {orders.map((order) => (
                    <tr key={order.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">{order.number}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(order.date)}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{order.expectedOn ? formatIsoDate(order.expectedOn) : ""}</td>
                      <td className="py-2 pr-4">{order.supplierName}</td>
                      <td className="py-2 pr-4">{order.warehouseName}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{order.linesLeft}</td>
                      <td className="py-2 text-right whitespace-nowrap">
                        {manage ? (
                          <Link href={`/purchases/receive/${order.id}`} aria-label={`Receive goods against ${order.number}`} className="font-medium underline-offset-4 hover:underline">
                            Receive
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Goods received notes">
          {rows.length === 0 ? (
            <Empty>No goods have been received yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Goods received notes" className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Number</th>
                    <th className="py-2 pr-4 font-medium">Arrived on</th>
                    <th className="py-2 pr-4 font-medium">Supplier</th>
                    <th className="py-2 pr-4 font-medium">Warehouse</th>
                    <th className="py-2 pr-4 text-right font-medium">Items</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        <Link href={`/purchases/receipts/${row.id}`} className="underline-offset-4 hover:underline">
                          {row.number ?? "Draft"}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                      <td className="py-2 pr-4">{row.supplierName}</td>
                      <td className="py-2 pr-4">{row.warehouseName}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.lines}</td>
                      <td className="py-2">
                        <Pill label={RECEIPT_STATUS_LABELS[row.status]} strong={row.status === "posted"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 notes.</p> : null}
        </Card>
      </div>
    </>
  );
}

/** The lines of an order as the goods received form shows them: those with something to come, or already on the note. */
function formLines(toReceive: readonly OrderLineToReceive[], onNote: ReadonlyMap<string, string>) {
  return toReceive
    .filter((line) => stillToReceive(line).gt(0) || onNote.has(line.lineId))
    .map((line) => ({
      orderLineId: line.lineId,
      itemCode: line.itemCode,
      description: line.description,
      unitCode: line.unitCode,
      ordered: formatQuantity(line.ordered),
      received: formatQuantity(line.received),
      left: formatQuantity(stillToReceive(line)),
      quantity: onNote.get(line.lineId) ?? "",
    }));
}

function OrderFacts({ order }: { order: { number: string; date: string; supplierName: string; warehouseName: string } }) {
  return (
    <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Order</dt>
      <dd>
        {order.number}, {formatIsoDate(order.date)}
      </dd>
      <dt className="text-muted-foreground">Supplier</dt>
      <dd>{order.supplierName}</dd>
      <dt className="text-muted-foreground">Warehouse</dt>
      <dd>{order.warehouseName}</dd>
    </dl>
  );
}

export async function NewReceiptScreen({ params }: { params: Promise<{ order: string }> }) {
  const session = await requireTenant();
  if (!can(session.role, "goods_receipt.manage") || !session.modules.purchasing) return <Refused title="Receive goods">Only an owner, an accountant or the warehouse can receive goods.</Refused>;
  const { order: orderId } = await params;
  const found = await getOrderToReceive(session, orderId);
  if (!found) notFound();
  const lines = formLines(found.toReceive, new Map());
  const back = <Back href="/purchases/receive" label="Receive goods" />;
  if (found.draftId) {
    return (
      <>
        {back}
        <PageHead title={`Receive goods against ${found.order.number}`} />
        <p className="text-muted-foreground">
          A goods received note for this order is already waiting as a draft.{" "}
          <Link href={`/purchases/receipts/${found.draftId}`} className="font-medium text-foreground underline underline-offset-4">
            Open the draft
          </Link>
          .
        </p>
      </>
    );
  }
  return (
    <>
      {back}
      <PageHead title={`Receive goods against ${found.order.number}`} sub="The goods are in the warehouse as soon as the note is posted. It gets its number then." />
      {lines.length === 0 ? (
        <p className="text-muted-foreground">Everything on this order has arrived.</p>
      ) : (
        <Card className="max-w-5xl">
          <OrderFacts order={found.order} />
          <ReceiptForm action={saveReceiptAction.bind(null, null, found.order.id, "")} lines={lines} initial={{ date: todayIso(new Date()), supplierDeliveryNote: "", note: "" }} />
        </Card>
      )}
    </>
  );
}

export async function ReceiptScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "goods_receipt.read") || !session.modules.purchasing) return <Refused title="Goods received">{NO_RECEIPTS}</Refused>;
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const receipt = await getReceipt(session, id);
  if (!receipt) notFound();
  const loadedAt = receipt.updatedAt.toISOString();
  const back = <Back href="/purchases/receive" label="Receive goods" />;
  const order = receipt.order;

  if (receipt.status === "draft" && can(session.role, "goods_receipt.manage") && order) {
    const onNote = new Map(receipt.lines.map((line) => [line.orderLineId, formatQuantity(line.quantity)]));
    return (
      <>
        {back}
        <PageHead title="Draft goods received note" sub="Nothing has come into stock yet. It gets its number when it is posted." />
        <div className="flex max-w-5xl flex-col gap-5">
          <Card>
            <OrderFacts order={order} />
            <ReceiptForm
              action={saveReceiptAction.bind(null, receipt.id, receipt.orderId, loadedAt)}
              lines={formLines(receipt.toReceive, onNote)}
              initial={{ date: receipt.date, supplierDeliveryNote: receipt.supplierDeliveryNote ?? "", note: receipt.note ?? "" }}
              refused={refusedNote(refused, "posted")}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardReceiptAction.bind(null, receipt.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const units = new Map(receipt.toReceive.map((line) => [line.lineId, line.unitCode]));
  return (
    <>
      {back}
      <PageHead title={receipt.number ?? "Draft goods received note"} sub={receipt.note ?? undefined} />
      <Card className="max-w-4xl">
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Arrived on</dt>
          <dd>{formatIsoDate(receipt.date)}</dd>
          <dt className="text-muted-foreground">Order</dt>
          <dd>
            {order && can(session.role, "purchase_order.read") ? (
              <Link href={`/purchases/${receipt.orderId}`} className="underline-offset-4 hover:underline">
                {order.number}
              </Link>
            ) : (
              (order?.number ?? "")
            )}
          </dd>
          <dt className="text-muted-foreground">Supplier</dt>
          <dd>{receipt.supplierName}</dd>
          <dt className="text-muted-foreground">Warehouse</dt>
          <dd>{receipt.warehouseName}</dd>
          {receipt.supplierDeliveryNote ? (
            <>
              <dt className="text-muted-foreground">Supplier&apos;s delivery note</dt>
              <dd>{receipt.supplierDeliveryNote}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Pill label={RECEIPT_STATUS_LABELS[receipt.status]} strong={receipt.status === "posted"} testId="document-status" />
            {receipt.status === "posted" ? <span className="text-muted-foreground"> Posted goods received are never changed.</span> : null}
          </dd>
          {receipt.journalId && can(session.role, "journal.read") ? (
            <>
              <dt className="text-muted-foreground">In the books</dt>
              <dd>
                <Link href={`/journals/${receipt.journalId}`} className="underline-offset-4 hover:underline">
                  See the journal
                </Link>
              </dd>
            </>
          ) : null}
        </dl>
        <div className="overflow-x-auto">
          <table aria-label="Goods received lines" className="w-full min-w-[420px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Item code</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                <th className="py-2 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {receipt.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                  <td className="py-2 pr-4">{line.itemName}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(line.quantity)}</td>
                  <td className="py-2 text-muted-foreground">{units.get(line.orderLineId) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ── goods received, not yet billed ──────────────────────────────────────────────────────────────

export async function GrniScreen() {
  const session = await requireTenant();
  if (!can(session.role, "purchase_order.read") || !session.modules.purchasing) return <Refused title="Goods received, not yet billed">Only an owner, an accountant or an auditor can see what goods cost.</Refused>;
  const { rows, total, ledger } = await getGrni(session);
  const agrees = total.eq(ledger);
  return (
    <>
      <PageHead title="Goods received, not yet billed" sub="Goods that have arrived and have no supplier bill yet, at what they cost. This is what is owed to suppliers and not yet billed." />
      <Sections session={session} current="/purchases/grni" />
      <Card className="max-w-5xl">
        {rows.length === 0 ? (
          <Empty>No goods are waiting for a supplier&apos;s bill.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Goods received, not yet billed" className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Note</th>
                  <th className="py-2 pr-4 font-medium">Arrived on</th>
                  <th className="py-2 pr-4 font-medium">Supplier</th>
                  <th className="py-2 pr-4 font-medium">Order</th>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                  <th className="py-2 pr-4 font-medium">Unit</th>
                  <th className="py-2 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row, index) => (
                  <tr key={`${row.receiptId}-${index}`}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/purchases/receipts/${row.receiptId}`} className="underline-offset-4 hover:underline">
                        {row.receiptNumber}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.supplierName}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.orderNumber}</td>
                    <td className="py-2 pr-4">
                      <span className="font-medium">{row.itemCode}</span> {row.description}
                    </td>
                    <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(row.quantity)}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{row.unitCode}</td>
                    <td className="py-2 text-right tabular-nums">{formatAmount(row.value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t">
                <tr>
                  <td colSpan={7} className="py-2 pr-4 text-right font-medium">
                    Total
                  </td>
                  <td className="py-2 text-right font-semibold tabular-nums" data-testid="grni-total">
                    {formatAmount(total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <p role="status" data-testid="grni-agrees" className={`mt-3 text-sm ${agrees ? "text-muted-foreground" : "font-medium text-destructive"}`}>
          {agrees
            ? `The account Goods received not invoiced holds ${formatAmount(ledger)} in the books: the same.`
            : `The account Goods received not invoiced holds ${formatAmount(ledger)} in the books, and this list comes to ${formatAmount(total)}. They should be the same; tell whoever looks after the system.`}
        </p>
      </Card>
    </>
  );
}
