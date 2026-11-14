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
import {
  getStockAdjustment,
  getStockCount,
  getStockTransfer,
  listItemChoices,
  listStockAdjustments,
  listStockCounts,
  listStockOnHand,
  listStockTransfers,
  type StockCount,
} from "@/modules/inventory/queries";
import { ADJUSTMENT_REASONS, REASON_LABELS, countDifference, formatQuantity, isAdjustmentKind, type AdjustmentKind, type StockDocumentStatus } from "@/modules/inventory/rules";
import { can, type Permission } from "@/modules/tenant/rules";
import { listWarehouses } from "@/modules/warehouses/queries";
import {
  addCountItemAction,
  countStepAction,
  discardAdjustmentAction,
  discardTransferAction,
  importOpeningAction,
  postCountAction,
  saveAdjustmentAction,
  saveCountAction,
  saveTransferAction,
  startCountAction,
} from "./actions";
import { CountForm } from "./count-form";
import { StockLinesForm } from "./lines-form";
import { OpeningImport } from "./opening-import";

const OPENING_MAX_BYTES = 512 * 1024;
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const STATUS_LABELS: Record<StockDocumentStatus, string> = { draft: "Draft", submitted: "Finished, to be posted", posted: "Posted" };
const COUNT_LABELS: Record<StockDocumentStatus, string> = { draft: "Being counted", submitted: "Finished, to be posted", posted: "Posted" };
const KIND_LABELS: Record<AdjustmentKind, string> = { adjustment: "Adjustment", opening: "Opening stock" };

function StatusPill({ status, labels = STATUS_LABELS, testId }: { status: StockDocumentStatus; labels?: Record<StockDocumentStatus, string>; testId?: string }) {
  const tone = status === "posted" ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground";
  return (
    <span data-testid={testId} className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>
      {labels[status]}
    </span>
  );
}

function Refused({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <PageHead title={title} />
      <p className="text-muted-foreground">{children}</p>
    </>
  );
}

const SECTIONS: readonly { href: string; label: string; permission: Permission }[] = [
  { href: "/stock", label: "Stock on hand", permission: "stock.read" },
  { href: "/stock/transfers", label: "Transfers", permission: "stock_transfer.read" },
  { href: "/stock/adjustments", label: "Adjustments and opening stock", permission: "stock_adjustment.read" },
  { href: "/stock/counts", label: "Stock counts", permission: "stock_count.read" },
];

/** The stock screens this role may open, as a row of links above each of them. */
function Sections({ session, current }: { session: TenantSession; current: string }) {
  const open = SECTIONS.filter((section) => can(session.role, section.permission));
  if (open.length < 2) return null;
  return (
    <nav aria-label="Stock" className="mb-4 flex flex-wrap gap-x-5 gap-y-1 border-b pb-2 text-sm">
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

function Back({ href, label }: { href: string; label: string }) {
  return (
    <p className="mb-2 text-sm">
      <Link href={href} className="text-muted-foreground underline-offset-4 hover:underline">
        {label}
      </Link>
    </p>
  );
}

const plain = (value: { toFixed(): string } | null) => (value === null ? "" : value.toFixed());

// ── stock on hand ───────────────────────────────────────────────────────────────────────────────

export async function StockScreen({ searchParams }: { searchParams: Promise<{ warehouse?: string | string[]; q?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "stock.read") || !session.modules.inventory) return <Refused title="Stock">Your role does not include stock.</Refused>;
  const query = await searchParams;
  const warehouseId = typeof query.warehouse === "string" ? query.warehouse : "";
  const search = typeof query.q === "string" ? query.q.slice(0, 80) : "";
  const [warehouses, { rows, more }] = await Promise.all([listWarehouses(session), listStockOnHand(session, { warehouseId, search })]);
  return (
    <>
      <PageHead title="Stock" sub="What each warehouse holds now, in each item's own unit." />
      <Sections session={session} current="/stock" />
      <form method="get" className="mb-4 flex max-w-3xl flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="warehouse" className="text-sm font-medium">
            Warehouse
          </label>
          <select id="warehouse" name="warehouse" defaultValue={warehouseId} className={`${SELECT} w-52`}>
            <option value="">All warehouses</option>
            {warehouses.map((warehouse) => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="Item code or name" name="q" defaultValue={search} autoComplete="off" className="w-56" />
        <button type="submit" className={buttonVariants({ variant: "outline" })}>
          Show
        </button>
      </form>
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>{warehouseId || search ? "Nothing in stock matches." : "Nothing is in stock yet. Stock comes in as opening stock, or with goods received."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Stock on hand" className="w-full min-w-[520px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Item code</th>
                  <th className="py-2 pr-4 font-medium">Item</th>
                  <th className="py-2 pr-4 font-medium">Warehouse</th>
                  <th className="py-2 pr-2 text-right font-medium">In stock</th>
                  <th className="py-2 font-medium">Unit</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={`${row.itemId}-${row.warehouseId}`}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">{row.code}</td>
                    <td className="py-2 pr-4">{row.name}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.warehouse}</td>
                    <td className="py-2 pr-2 text-right whitespace-nowrap tabular-nums">{formatQuantity(row.quantity)}</td>
                    <td className="py-2 text-muted-foreground">{row.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the first 1,000 lines. Choose a warehouse or search to see the rest.</p> : null}
      </Card>
    </>
  );
}

// ── transfers ───────────────────────────────────────────────────────────────────────────────────

const NO_TRANSFERS = "Your role does not include stock transfers.";

export async function TransfersScreen() {
  const session = await requireTenant();
  if (!can(session.role, "stock_transfer.read") || !session.modules.inventory) return <Refused title="Stock transfers">{NO_TRANSFERS}</Refused>;
  const { rows, more } = await listStockTransfers(session);
  return (
    <>
      <PageHead title="Stock transfers" sub="Goods moved from one warehouse to another." />
      <Sections session={session} current="/stock/transfers" />
      {can(session.role, "stock_transfer.manage") ? (
        <p className="mb-4">
          <Link href="/stock/transfers/new" className={buttonVariants()}>
            New transfer
          </Link>
        </p>
      ) : null}
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>No transfers yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Stock transfers" className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">From</th>
                  <th className="py-2 pr-4 font-medium">To</th>
                  <th className="py-2 pr-4 text-right font-medium">Items</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/stock/transfers/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">{row.fromWarehouse}</td>
                    <td className="py-2 pr-4">{row.toWarehouse}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.lines}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 transfers.</p> : null}
      </Card>
    </>
  );
}

async function lineChoices(session: TenantSession) {
  const [warehouses, items] = await Promise.all([listWarehouses(session), listItemChoices(session)]);
  return { warehouses: warehouses.map((warehouse) => ({ id: warehouse.id, name: warehouse.name })), items: items.map((item) => ({ code: item.code, name: item.name, unit: item.unit })) };
}

function NeedsTwoWarehouses() {
  return <p className="text-muted-foreground">A transfer goes from one warehouse to another of the same branch, and you have only one. An owner adds warehouses under Settings, Branches.</p>;
}

export async function NewTransferScreen() {
  const session = await requireTenant();
  if (!can(session.role, "stock_transfer.manage") || !session.modules.inventory) return <Refused title="New transfer">Only an owner, an accountant or the warehouse can transfer stock.</Refused>;
  const choices = await lineChoices(session);
  return (
    <>
      <Back href="/stock/transfers" label="Stock transfers" />
      <PageHead title="New transfer" sub="The goods are in the other warehouse as soon as the transfer is posted. Both warehouses belong to the same branch." />
      {choices.warehouses.length < 2 ? (
        <NeedsTwoWarehouses />
      ) : (
        <Card className="max-w-4xl">
          <StockLinesForm action={saveTransferAction.bind(null, null, "")} mode="transfer" {...choices} initial={{ date: todayIso(new Date()), warehouseId: "", toWarehouseId: "", reason: "", note: "", lines: [] }} />
        </Card>
      )}
    </>
  );
}

export async function TransferScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "stock_transfer.read") || !session.modules.inventory) return <Refused title="Stock transfer">{NO_TRANSFERS}</Refused>;
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const transfer = await getStockTransfer(session, id);
  if (!transfer) notFound();
  const loadedAt = transfer.updatedAt.toISOString();
  const back = <Back href="/stock/transfers" label="Stock transfers" />;

  if (transfer.status === "draft" && can(session.role, "stock_transfer.manage")) {
    const choices = await lineChoices(session);
    // A member of one branch can read a draft into it, and can change only what lies wholly in its own warehouses.
    const own = choices.warehouses.some((w) => w.id === transfer.fromWarehouseId) && choices.warehouses.some((w) => w.id === transfer.toWarehouseId);
    if (own) {
      return (
        <>
          {back}
          <PageHead title="Draft transfer" sub="Nothing has moved yet. It gets its number when it is posted." />
          <div className="flex max-w-4xl flex-col gap-5">
            <Card>
              <StockLinesForm
                action={saveTransferAction.bind(null, transfer.id, loadedAt)}
                mode="transfer"
                {...choices}
                initial={{
                  date: transfer.date,
                  warehouseId: transfer.fromWarehouseId,
                  toWarehouseId: transfer.toWarehouseId,
                  reason: "",
                  note: transfer.note ?? "",
                  lines: transfer.lines.map((line) => ({ itemCode: line.code, direction: "in", quantity: formatQuantity(line.quantity), unitCost: "" })),
                }}
                refused={typeof refused === "string" && refused !== "" ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
              />
            </Card>
            <Card title="Throw this draft away">
              <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
              <ActionForm action={discardTransferAction.bind(null, transfer.id, loadedAt)} submitLabel="Discard draft" compact />
            </Card>
          </div>
        </>
      );
    }
  }

  return (
    <>
      {back}
      <PageHead title={transfer.number ?? "Draft transfer"} sub={transfer.note ?? undefined} />
      <Card className="max-w-4xl">
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatIsoDate(transfer.date)}</dd>
          <dt className="text-muted-foreground">From</dt>
          <dd>{transfer.fromWarehouse}</dd>
          <dt className="text-muted-foreground">To</dt>
          <dd>{transfer.toWarehouse}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusPill status={transfer.status} testId="document-status" />
            {transfer.status === "posted" ? <span className="text-muted-foreground"> A posted transfer is never changed. To undo it, transfer the goods back.</span> : null}
          </dd>
        </dl>
        <div className="overflow-x-auto">
          <table aria-label="Transfer lines" className="w-full min-w-[420px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Item code</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                <th className="py-2 font-medium">Unit</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {transfer.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.code}</td>
                  <td className="py-2 pr-4">{line.name}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(line.quantity)}</td>
                  <td className="py-2 text-muted-foreground">{line.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

// ── adjustments and opening stock ───────────────────────────────────────────────────────────────

const NO_ADJUSTMENTS = "Only an owner, an accountant or an auditor can see stock adjustments.";
const REASONS = ADJUSTMENT_REASONS.map((value) => ({ value, label: REASON_LABELS[value] }));

export async function AdjustmentsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "stock_adjustment.read") || !session.modules.inventory) return <Refused title="Stock adjustments">{NO_ADJUSTMENTS}</Refused>;
  const { rows, more } = await listStockAdjustments(session);
  return (
    <>
      <PageHead title="Adjustments and opening stock" sub="Stock put right by hand, with the reason; and the stock a company holds on the day it starts here." />
      <Sections session={session} current="/stock/adjustments" />
      {can(session.role, "stock_adjustment.manage") ? (
        <p className="mb-4 flex flex-wrap gap-2">
          <Link href="/stock/adjustments/new" className={buttonVariants()}>
            New adjustment
          </Link>
          <Link href="/stock/adjustments/new?kind=opening" className={buttonVariants({ variant: "outline" })}>
            Enter opening stock
          </Link>
        </p>
      ) : null}
      <Card className="max-w-4xl">
        {rows.length === 0 ? (
          <Empty>No adjustments or opening stock yet.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Adjustments and opening stock" className="w-full min-w-[620px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Number</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">What it is</th>
                  <th className="py-2 pr-4 font-medium">Warehouse</th>
                  <th className="py-2 pr-4 text-right font-medium">Items</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/stock/adjustments/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.number ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                    <td className="py-2 pr-4">
                      {row.reason ? REASON_LABELS[row.reason] : KIND_LABELS[row.kind]}
                      {row.note ? <span className="text-muted-foreground">: {row.note}</span> : null}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.warehouse}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{row.lines}</td>
                    <td className="py-2">
                      <StatusPill status={row.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200.</p> : null}
      </Card>
    </>
  );
}

export async function NewAdjustmentScreen({ searchParams }: { searchParams: Promise<{ kind?: string | string[] }> }) {
  const session = await requireTenant();
  const { kind: asked } = await searchParams;
  const kind: AdjustmentKind = isAdjustmentKind(asked) ? asked : "adjustment";
  const title = kind === "opening" ? "Opening stock" : "New adjustment";
  if (!can(session.role, "stock_adjustment.manage") || !session.modules.inventory) return <Refused title={title}>Only an owner or an accountant can adjust stock or enter opening stock.</Refused>;
  const choices = await lineChoices(session);
  const today = todayIso(new Date());
  const only = choices.warehouses.length === 1 ? choices.warehouses[0].id : "";
  return (
    <>
      <Back href="/stock/adjustments" label="Adjustments and opening stock" />
      <PageHead
        title={title}
        sub={
          kind === "opening"
            ? "What a warehouse holds on the day the company starts here, at what it cost. It comes into the books against opening balance equity."
            : "Goods written off, or goods added, in one warehouse. The value goes to the Stock adjustments account."
        }
      />
      <div className="flex max-w-4xl flex-col gap-5">
        <Card title={kind === "opening" ? "Type it in" : undefined}>
          <StockLinesForm action={saveAdjustmentAction.bind(null, kind, null, "")} mode={kind} {...choices} reasons={REASONS} initial={{ date: today, warehouseId: only, toWarehouseId: "", reason: "", note: "", lines: [] }} />
        </Card>
        {kind === "opening" ? (
          <Card title="Or read it from a file">
            <p className="mb-3 text-sm text-muted-foreground">
              A CSV file for one warehouse, with three columns in its first row: <strong>Item code</strong>, <strong>Quantity</strong> and <strong>Unit cost</strong>. Up to 2,000 rows. The items must be on the
              item list already. The file is read into a draft, which you look over before posting.
            </p>
            <OpeningImport action={importOpeningAction} warehouses={choices.warehouses} today={today} maxBytes={OPENING_MAX_BYTES} />
          </Card>
        ) : null}
      </div>
    </>
  );
}

export async function AdjustmentScreen({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ refused?: string | string[] }> }) {
  const session = await requireTenant();
  if (!can(session.role, "stock_adjustment.read") || !session.modules.inventory) return <Refused title="Stock adjustment">{NO_ADJUSTMENTS}</Refused>;
  const [{ id }, { refused }] = await Promise.all([params, searchParams]);
  const adjustment = await getStockAdjustment(session, id);
  if (!adjustment) notFound();
  const loadedAt = adjustment.updatedAt.toISOString();
  const opening = adjustment.kind === "opening";
  const back = <Back href="/stock/adjustments" label="Adjustments and opening stock" />;

  if (adjustment.status === "draft" && can(session.role, "stock_adjustment.manage")) {
    const choices = await lineChoices(session);
    return (
      <>
        {back}
        <PageHead title={opening ? "Draft opening stock" : "Draft adjustment"} sub="Not in the books yet, and no stock has moved. It gets its number when it is posted." />
        <div className="flex max-w-4xl flex-col gap-5">
          <Card>
            <StockLinesForm
              action={saveAdjustmentAction.bind(null, adjustment.kind, adjustment.id, loadedAt)}
              mode={adjustment.kind}
              {...choices}
              reasons={REASONS}
              initial={{
                date: adjustment.date,
                warehouseId: adjustment.warehouseId,
                toWarehouseId: "",
                reason: adjustment.reason ?? "",
                note: adjustment.note ?? "",
                lines: adjustment.lines.map((line) => ({
                  itemCode: line.code,
                  direction: line.quantity.isNegative() ? "out" : "in",
                  quantity: formatQuantity(line.quantity.abs()),
                  unitCost: line.unitCost === null ? "" : formatQuantity(line.unitCost),
                })),
              }}
              refused={typeof refused === "string" && refused !== "" ? "Saved as a draft, but not posted. Post it again to see why." : undefined}
            />
          </Card>
          <Card title="Throw this draft away">
            <p className="mb-3 text-sm text-muted-foreground">A draft has no number, so removing it leaves no gap.</p>
            <ActionForm action={discardAdjustmentAction.bind(null, adjustment.id, loadedAt)} submitLabel="Discard draft" compact />
          </Card>
        </div>
      </>
    );
  }

  const total = adjustment.lines.reduce((sum, line) => (line.value === null ? sum : line.quantity.isNegative() ? sum.minus(line.value) : sum.plus(line.value)), new Decimal(0));
  return (
    <>
      {back}
      <PageHead title={adjustment.number ?? (opening ? "Draft opening stock" : "Draft adjustment")} sub={adjustment.note ?? undefined} />
      <Card className="max-w-4xl">
        <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Date</dt>
          <dd>{formatIsoDate(adjustment.date)}</dd>
          <dt className="text-muted-foreground">Warehouse</dt>
          <dd>{adjustment.warehouse}</dd>
          <dt className="text-muted-foreground">What it is</dt>
          <dd>{adjustment.reason ? REASON_LABELS[adjustment.reason] : KIND_LABELS[adjustment.kind]}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <StatusPill status={adjustment.status} testId="document-status" />
            {adjustment.status === "posted" ? <span className="text-muted-foreground"> A posted entry is never changed. To correct it, post an opposite one.</span> : null}
          </dd>
        </dl>
        <div className="overflow-x-auto">
          <table aria-label="Adjustment lines" className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">Item code</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                <th className="py-2 pr-4 font-medium">Unit</th>
                <th className="py-2 pr-4 text-right font-medium">Cost of one</th>
                <th className="py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {adjustment.lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.code}</td>
                  <td className="py-2 pr-4">{line.name}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{line.quantity.isNegative() ? `-${formatQuantity(line.quantity.abs())}` : `+${formatQuantity(line.quantity)}`}</td>
                  <td className="py-2 pr-4 text-muted-foreground">{line.unit}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{line.unitCost === null ? <span className="text-muted-foreground">average</span> : formatAmount(line.unitCost)}</td>
                  <td className="py-2 text-right tabular-nums">{line.value === null ? "" : formatAmount(line.quantity.isNegative() ? line.value.negated() : line.value)}</td>
                </tr>
              ))}
            </tbody>
            {adjustment.status === "posted" ? (
              <tfoot className="border-t font-bold">
                <tr>
                  <td className="py-2 pr-4" colSpan={5}>
                    Change in what stock is worth
                  </td>
                  <td className="py-2 text-right tabular-nums" data-testid="adjustment-total">
                    {formatAmount(total)}
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </Card>
    </>
  );
}

// ── counts ──────────────────────────────────────────────────────────────────────────────────────

const NO_COUNTS = "Your role does not include stock counts.";

export async function CountsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "stock_count.read") || !session.modules.inventory) return <Refused title="Stock counts">{NO_COUNTS}</Refused>;
  const [{ rows, more }, warehouses] = await Promise.all([listStockCounts(session), can(session.role, "stock_count.manage") ? listWarehouses(session) : []]);
  return (
    <>
      <PageHead title="Stock counts" sub="The shelves counted against the books. The warehouse counts; an owner or an accountant posts the differences." />
      <Sections session={session} current="/stock/counts" />
      <div className="flex max-w-4xl flex-col gap-5">
        {can(session.role, "stock_count.manage") ? (
          <Card title="Start a count">
            <ActionForm action={startCountAction} submitLabel="Start count">
              <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="warehouseId" className="text-sm font-medium">
                    Warehouse to count
                  </label>
                  <select id="warehouseId" name="warehouseId" defaultValue={warehouses.length === 1 ? warehouses[0].id : ""} required className={SELECT}>
                    <option value="">Choose a warehouse</option>
                    {warehouses.map((warehouse) => (
                      <option key={warehouse.id} value={warehouse.id}>
                        {warehouse.name}
                      </option>
                    ))}
                  </select>
                </div>
                <Field label="Date of the count" name="date" type="date" defaultValue={todayIso(new Date())} required />
              </div>
              <Field label="Note" name="note" maxLength={500} autoComplete="off" hint="The sheet lists every item the books say the warehouse holds. Count while nothing is moving in or out, if you can." />
            </ActionForm>
          </Card>
        ) : null}
        <Card>
          {rows.length === 0 ? (
            <Empty>No stock counts yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Stock counts" className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Number</th>
                    <th className="py-2 pr-4 font-medium">Date</th>
                    <th className="py-2 pr-4 font-medium">Warehouse</th>
                    <th className="py-2 pr-4 text-right font-medium">Counted</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        <Link href={`/stock/counts/${row.id}`} className="underline-offset-4 hover:underline">
                          {row.number ?? "Count sheet"}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.date)}</td>
                      <td className="py-2 pr-4">{row.warehouse}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {row.counted} of {row.lines}
                      </td>
                      <td className="py-2">
                        <StatusPill status={row.status} labels={COUNT_LABELS} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 counts.</p> : null}
        </Card>
      </div>
    </>
  );
}

/** The counted lines whose stock is no longer what the sheet says the books held. */
const movedLines = (count: StockCount) => count.lines.filter((line) => line.counted !== null && !line.onHand.eq(line.book));

function CountTable({ count, showMoved }: { count: StockCount; showMoved: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label="Count sheet" className="w-full min-w-[560px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">Item code</th>
            <th className="py-2 pr-4 font-medium">Item</th>
            <th className="py-2 pr-4 text-right font-medium">Books said</th>
            <th className="py-2 pr-4 text-right font-medium">Counted</th>
            <th className="py-2 pr-4 text-right font-medium">Difference</th>
            <th className="py-2 font-medium">Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {count.lines.map((line) => {
            const difference = countDifference(line.book, line.counted);
            const moved = showMoved && line.counted !== null && !line.onHand.eq(line.book);
            return (
              <tr key={line.id}>
                <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.code}</td>
                <td className="py-2 pr-4">
                  {line.name}
                  {moved ? (
                    <span className="block text-xs text-destructive" data-testid={`moved-${line.code}`}>
                      Stock has moved since: the books now say {formatQuantity(line.onHand)}.
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatQuantity(line.book)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{line.counted === null ? <span className="text-muted-foreground">not counted</span> : formatQuantity(line.counted)}</td>
                <td className={`py-2 pr-4 text-right tabular-nums ${difference !== null && difference.isNegative() ? "text-destructive" : ""}`}>
                  {difference === null || difference.isZero() ? "" : `${difference.isPositive() ? "+" : "-"}${formatQuantity(difference.abs())}`}
                </td>
                <td className="py-2 text-muted-foreground">{line.unit}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export async function CountScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  if (!can(session.role, "stock_count.read") || !session.modules.inventory) return <Refused title="Stock count">{NO_COUNTS}</Refused>;
  const { id } = await params;
  const count = await getStockCount(session, id);
  if (!count) notFound();
  const loadedAt = count.updatedAt.toISOString();
  const manager = can(session.role, "stock_count.manage");
  const poster = can(session.role, "stock_count.post");
  const back = <Back href="/stock/counts" label="Stock counts" />;
  const head = (
    <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Warehouse</dt>
      <dd>{count.warehouse}</dd>
      <dt className="text-muted-foreground">Date</dt>
      <dd>{formatIsoDate(count.date)}</dd>
      {count.note ? (
        <>
          <dt className="text-muted-foreground">Note</dt>
          <dd>{count.note}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Status</dt>
      <dd>
        <StatusPill status={count.status} labels={COUNT_LABELS} testId="document-status" />
      </dd>
    </dl>
  );

  if (count.status === "draft" && manager) {
    const moved = movedLines(count);
    return (
      <>
        {back}
        <PageHead title={`Count of ${count.warehouse}`} sub="Enter what is on the shelves. Nothing changes in the books until the count is finished and then posted." />
        <div className="flex max-w-4xl flex-col gap-5">
          <Card>
            <p className="mb-4 text-sm">
              <Link href={`/print/stock-count/${count.id}`} className="font-semibold text-primary hover:underline">
                Print the count sheet
              </Link>
            </p>
            <CountForm
              action={saveCountAction.bind(null, count.id, loadedAt)}
              initial={{ date: count.date, note: count.note ?? "" }}
              lines={count.lines.map((line) => ({ id: line.id, code: line.code, name: line.name, unit: line.unit, book: formatQuantity(line.book), counted: plain(line.counted) }))}
              showBook={poster}
            />
          </Card>
          <Card title="Something on the shelf that is not on the sheet">
            <ActionForm action={addCountItemAction.bind(null, count.id, loadedAt)} submitLabel="Add to the sheet">
              <Field label="Item code" name="itemCode" id="add-item-code" required maxLength={30} autoComplete="off" className="max-w-[14rem]" hint="Save what you have counted first; adding an item reloads the sheet." />
            </ActionForm>
          </Card>
          {moved.length > 0 ? (
            <Card title="Stock has moved since this sheet was started">
              <p className="mb-3 text-sm text-muted-foreground" data-testid="moved-note">
                {moved.map((line) => line.code).join(", ")}: what the books hold has changed since the sheet was made. If the shelves were counted before that, leave the sheet as it is. If they were counted
                after, or you cannot say, bring the sheet up to date: these items are then compared with what the books hold now, and what was entered for them is cleared, to be counted again.
              </p>
              <ActionForm action={countStepAction.bind(null, "rebook", count.id, loadedAt)} submitLabel="Bring the sheet up to date" compact />
            </Card>
          ) : null}
          <Card title="Throw this sheet away">
            <p className="mb-3 text-sm text-muted-foreground">Nothing has been posted, so nothing changes in the books.</p>
            <ActionForm action={countStepAction.bind(null, "discard", count.id, loadedAt)} submitLabel="Discard count" compact />
          </Card>
        </div>
      </>
    );
  }

  const moved = count.status === "submitted" ? movedLines(count) : [];
  const counted = count.lines.filter((line) => line.counted !== null).length;
  return (
    <>
      {back}
      <PageHead title={count.number ?? `Count of ${count.warehouse}`} sub={count.status === "submitted" ? "Finished counting. The differences are not in the books until an owner or an accountant posts them." : undefined} />
      <div className="flex max-w-4xl flex-col gap-5">
        <Card>
          {head}
          <CountTable count={count} showMoved={count.status === "submitted"} />
          <p className="mt-3 text-sm text-muted-foreground">
            {counted} of {count.lines.length} counted.{counted < count.lines.length ? " Items not counted stay as the books have them." : ""}
            {count.status === "posted" ? " A posted count is never changed. To correct it, count again or post an adjustment." : ""}
          </p>
        </Card>
        {count.status === "submitted" && poster ? (
          moved.length === 0 ? (
            <Card title="Post the differences">
              <p className="mb-3 text-sm text-muted-foreground">
                Stock is changed by each difference, and what the differences are worth goes to the Stock adjustments account. A shortage leaves at the item&apos;s average cost; a surplus comes in at it.
              </p>
              <ActionForm action={postCountAction.bind(null, count.id, loadedAt, false)} submitLabel="Post count" />
            </Card>
          ) : (
            <Card title="Stock has moved since this sheet was started">
              <p className="mb-3 text-sm" data-testid="moved-note">
                {moved.map((line) => line.code).join(", ")}: what the books hold is no longer what the sheet compared the count with. Which came first?
              </p>
              <p className="mb-2 text-sm text-muted-foreground">
                <strong className="text-foreground">The shelves were counted first, and the stock moved afterwards.</strong> The differences are right; they are applied on top of what the books hold now.
              </p>
              <ActionForm action={postCountAction.bind(null, count.id, loadedAt, true)} submitLabel="Post count: counted before the stock moved" className="mb-5" />
              <p className="mb-2 text-sm text-muted-foreground">
                <strong className="text-foreground">The stock moved first, and the shelves were counted afterwards.</strong> Send the count back; the sheet is then brought up to date, these items are counted again, and it is finished again.
              </p>
              <ActionForm action={countStepAction.bind(null, "return", count.id, loadedAt)} submitLabel="Send back" compact />
            </Card>
          )
        ) : null}
        {count.status === "submitted" && manager && (moved.length === 0 || !poster) ? (
          <Card title={poster ? "Send it back to be counted again" : "Take it back to change it"}>
            <p className="mb-3 text-sm text-muted-foreground">The sheet opens again; nothing has been posted.</p>
            <ActionForm action={countStepAction.bind(null, "return", count.id, loadedAt)} submitLabel={poster ? "Send back" : "Take back"} compact />
          </Card>
        ) : null}
      </div>
    </>
  );
}
