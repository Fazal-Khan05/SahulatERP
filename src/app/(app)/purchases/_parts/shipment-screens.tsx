import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { formatQuantity } from "@/modules/inventory/rules";
import { getShipment, getShipmentChoices, listShipments, type Shipment } from "@/modules/shipments/queries";
import { CHARGE_BASES, CHARGE_BASIS_LABELS, CHARGE_CLASSES, CHARGE_CLASS_LABELS, SHIPMENT_STAGES, SHIPMENT_STAGE_LABELS, SHIPMENT_STATUS_LABELS } from "@/modules/shipments/rules";
import { can } from "@/modules/tenant/rules";
import { Back, Pill, Refused, Sections } from "./screens";
import { addShipmentChargeAction, addShipmentReceiptAction, allocateShipmentAction, cancelShipmentAction, openShipmentAction, removeShipmentChargeAction, removeShipmentReceiptAction, updateShipmentAction } from "./shipment-actions";
import { ChargeForm } from "./shipment-form";

const NO_SHIPMENTS = "Only an owner, an accountant or an auditor can see shipments.";
const IMPORTS_OFF = "Imports is switched off for this company. An owner can switch it on under Settings, Features.";
const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/** The fields that say how far a shipment has come and what identifies it at the port. */
function DetailFields({ shipment }: { shipment?: Shipment }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="stage" className="text-sm font-medium">
            How far it has come
          </label>
          <select id="stage" name="stage" defaultValue={shipment?.stage ?? "ordered"} className={SELECT}>
            {SHIPMENT_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {SHIPMENT_STAGE_LABELS[stage]}
              </option>
            ))}
          </select>
        </div>
        <Field label="Shipped from" name="origin" defaultValue={shipment?.origin ?? ""} maxLength={80} autoComplete="off" />
        <Field label="Port" name="port" defaultValue={shipment?.port ?? ""} maxLength={80} autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Container number" name="containerNo" defaultValue={shipment?.containerNo ?? ""} maxLength={60} autoComplete="off" />
        <Field label="Bill of lading number" name="blNumber" defaultValue={shipment?.blNumber ?? ""} maxLength={60} autoComplete="off" />
        <Field label="Letter of credit number" name="lcNumber" defaultValue={shipment?.lcNumber ?? ""} maxLength={60} autoComplete="off" />
      </div>
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Goods declaration (GD) number" name="gdNumber" defaultValue={shipment?.gdNumber ?? ""} maxLength={100} autoComplete="off" />
        <Field label="GD date" name="gdDate" type="date" defaultValue={shipment?.gdDate ?? ""} />
        <Field label="Customs value (rupees)" name="customsValue" defaultValue={shipment?.customsValue?.toFixed(2) ?? ""} inputMode="decimal" autoComplete="off" />
        <Field label="Expected on" name="expectedOn" type="date" defaultValue={shipment?.expectedOn ?? ""} />
      </div>
      <Field label="Note" name="note" defaultValue={shipment?.note ?? ""} maxLength={500} autoComplete="off" />
    </>
  );
}

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export async function ShipmentsScreen() {
  const session = await requireTenant();
  if (!can(session.role, "shipment.read") || !session.modules.purchasing) return <Refused title="Shipments">{NO_SHIPMENTS}</Refused>;
  if (!session.modules.imports) return <Refused title="Shipments">{IMPORTS_OFF}</Refused>;
  const { rows, more, inTransit } = await listShipments(session);
  return (
    <>
      <PageHead title="Shipments" sub="Consignments from suppliers, with the charges of bringing them in. Closing a shipment adds those charges to what its goods cost." />
      <Sections session={session} current="/purchases/shipments" />
      {can(session.role, "shipment.manage") ? (
        <p className="mb-4">
          <Link href="/purchases/shipments/new" className={buttonVariants()}>
            New shipment
          </Link>
        </p>
      ) : null}
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          {rows.length === 0 ? (
            <Empty>No shipments yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Shipments" className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Shipment</th>
                    <th className="py-2 pr-4 font-medium">Opened</th>
                    <th className="py-2 pr-4 font-medium">Supplier</th>
                    <th className="py-2 pr-4 font-medium">Container, GD</th>
                    <th className="py-2 pr-4 font-medium">Expected</th>
                    <th className="py-2 pr-4 font-medium">Stage</th>
                    <th className="py-2 pr-4 text-right font-medium">Charges waiting</th>
                    <th className="py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        <Link href={`/purchases/shipments/${row.id}`} className="underline-offset-4 hover:underline">
                          {row.number}
                        </Link>
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.openedOn)}</td>
                      <td className="py-2 pr-4">{row.supplierName}</td>
                      <td className="py-2 pr-4">{[row.containerNo, row.gdNumber].filter(Boolean).join(", ")}</td>
                      <td className="py-2 pr-4 whitespace-nowrap">{row.expectedOn ? formatIsoDate(row.expectedOn) : ""}</td>
                      <td className="py-2 pr-4">{SHIPMENT_STAGE_LABELS[row.stage]}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{row.waiting.isZero() ? "" : formatAmount(row.waiting)}</td>
                      <td className="py-2">
                        <Pill label={SHIPMENT_STATUS_LABELS[row.status]} strong={row.status === "closed"} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the newest 200 shipments.</p> : null}
        </Card>
        <Card title="Goods in transit">
          <p className="mb-3 text-sm text-muted-foreground">
            Import charges are billed to the account Goods in transit (choose it as the account on a supplier bill&apos;s line) and wait there until a shipment is closed. What the account holds should be the charges still waiting.
          </p>
          <dl className="grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">The account holds</dt>
            <dd className="text-right tabular-nums" data-testid="transit-ledger">
              {formatAmount(inTransit.ledger)}
            </dd>
            <dt className="text-muted-foreground">On shipments, not yet spread</dt>
            <dd className="text-right tabular-nums" data-testid="transit-on-shipments">
              {formatAmount(inTransit.onShipments)}
            </dd>
            <dt className="text-muted-foreground">Billed, not yet on a shipment</dt>
            <dd className="text-right tabular-nums" data-testid="transit-unassigned">
              {formatAmount(inTransit.notOnAShipment)}
            </dd>
          </dl>
        </Card>
      </div>
    </>
  );
}

// ── opening a shipment ──────────────────────────────────────────────────────────────────────────

export async function NewShipmentScreen() {
  const session = await requireTenant();
  if (!can(session.role, "shipment.manage") || !session.modules.purchasing) return <Refused title="New shipment">Only an owner or an accountant can work on shipments.</Refused>;
  if (!session.modules.imports) return <Refused title="New shipment">{IMPORTS_OFF}</Refused>;
  const choices = await getShipmentChoices(session);
  const back = <Back href="/purchases/shipments" label="Shipments" />;
  if (choices.suppliers.length === 0) {
    return (
      <>
        {back}
        <PageHead title="New shipment" />
        <p className="text-muted-foreground">Add a supplier first, under Suppliers.</p>
      </>
    );
  }
  return (
    <>
      {back}
      <PageHead title="New shipment" sub="It gets its number as it is opened. Goods and charges are put on it afterwards." />
      <Card className="max-w-5xl">
        <ActionForm action={openShipmentAction} submitLabel="Open shipment" className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="supplierId" className="text-sm font-medium">
                Supplier
              </label>
              <select id="supplierId" name="supplierId" defaultValue="" required className={SELECT}>
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
                <label htmlFor="branchId" className="text-sm font-medium">
                  Branch
                </label>
                <select id="branchId" name="branchId" defaultValue="" required className={SELECT}>
                  <option value="">Choose a branch</option>
                  {choices.branches.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input type="hidden" name="branchId" value={choices.branches[0]?.id ?? ""} />
            )}
            <Field label="Opened on" name="openedOn" type="date" defaultValue={todayIso(new Date())} required />
          </div>
          <DetailFields />
        </ActionForm>
      </Card>
    </>
  );
}

// ── one shipment ────────────────────────────────────────────────────────────────────────────────

export async function ShipmentScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  if (!can(session.role, "shipment.read") || !session.modules.purchasing) return <Refused title="Shipment">{NO_SHIPMENTS}</Refused>;
  if (!session.modules.imports) return <Refused title="Shipment">{IMPORTS_OFF}</Refused>;
  const { id } = await params;
  const shipment = await getShipment(session, id);
  if (!shipment) notFound();
  const loadedAt = shipment.updatedAt.toISOString();
  const manage = can(session.role, "shipment.manage") && shipment.status !== "cancelled";
  const open = shipment.status === "open";
  const waiting = shipment.charges.filter((charge) => charge.allocationId === null);
  const preview = shipment.preview && shipment.preview.ok ? shipment.preview.preview : null;
  const landed = shipment.goods.reduce((sum, line) => sum.plus(line.landed), new Decimal(0));
  return (
    <>
      <Back href="/purchases/shipments" label="Shipments" />
      <PageHead title={shipment.number} sub={`From ${shipment.supplierName}, opened ${formatIsoDate(shipment.openedOn)}${shipment.branchName ? `, ${shipment.branchName} branch` : ""}.`} />
      <div className="flex max-w-5xl flex-col gap-5">
        <Card>
          <p className="mb-4 text-sm">
            <Pill label={SHIPMENT_STATUS_LABELS[shipment.status]} strong={shipment.status === "closed"} testId="document-status" />{" "}
            <span className="text-muted-foreground">
              {shipment.status === "open"
                ? "Its charges have not been added to what its goods cost yet."
                : shipment.status === "closed"
                  ? "Its charges have been added to what its goods cost. A charge that comes later can still be put on it and spread."
                  : `Cancelled: ${shipment.cancelReason}.`}
            </span>
          </p>
          {manage ? (
            <ActionForm action={updateShipmentAction.bind(null, shipment.id, loadedAt)} submitLabel="Save details" className="flex flex-col gap-4">
              <DetailFields shipment={shipment} />
            </ActionForm>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">How far it has come</dt>
              <dd>{SHIPMENT_STAGE_LABELS[shipment.stage]}</dd>
              {(
                [
                  ["Shipped from", shipment.origin],
                  ["Port", shipment.port],
                  ["Container number", shipment.containerNo],
                  ["Bill of lading number", shipment.blNumber],
                  ["Letter of credit number", shipment.lcNumber],
                  ["Goods declaration (GD) number", shipment.gdNumber],
                  ["GD date", shipment.gdDate ? formatIsoDate(shipment.gdDate) : null],
                  ["Customs value", shipment.customsValue ? formatAmount(shipment.customsValue) : null],
                  ["Expected on", shipment.expectedOn ? formatIsoDate(shipment.expectedOn) : null],
                  ["Note", shipment.note],
                ] as const
              )
                .filter(([, value]) => value)
                .map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
            </dl>
          )}
        </Card>

        <Card title="Goods">
          {shipment.goods.length === 0 ? (
            <Empty>No goods are on this shipment yet. Put the goods received notes it brought on it.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Goods on the shipment" className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Goods received</th>
                    <th className="py-2 pr-4 font-medium">Item code</th>
                    <th className="py-2 pr-4 font-medium">Item</th>
                    <th className="py-2 pr-2 text-right font-medium">Quantity</th>
                    <th className="py-2 pr-4 font-medium">Unit</th>
                    <th className="py-2 pr-4 text-right font-medium">Came in at</th>
                    <th className="py-2 pr-4 text-right font-medium">Charges added</th>
                    <th className="py-2 text-right font-medium">Landed cost of one</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shipment.goods.map((line, index) => (
                    <tr key={line.receiptLineId}>
                      <td className="py-2 pr-4 whitespace-nowrap">{line.receiptNumber}</td>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">{line.itemCode}</td>
                      <td className="py-2 pr-4">{line.description}</td>
                      <td className="py-2 pr-2 text-right tabular-nums">{formatQuantity(line.quantity)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{line.unitCode}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(line.value)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums" data-testid={`landed-${index + 1}`}>
                        {formatAmount(line.landed)}
                      </td>
                      <td className="py-2 text-right tabular-nums" data-testid={`landed-each-${index + 1}`}>
                        {formatAmount(line.value.plus(line.landed).div(line.quantity))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!landed.isZero() ? <p className="mt-3 text-sm text-muted-foreground">Charges added to these goods in all: {formatAmount(landed)}. For goods already sold when a charge was spread, their part went to cost of goods sold.</p> : null}
          {manage && open ? (
            <div className="mt-4 flex flex-col gap-3">
              {shipment.receipts.map((receipt) => (
                <div key={receipt.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <span>
                    {receipt.number} of {formatIsoDate(receipt.date)}, into {receipt.warehouseName}
                  </span>
                  <ActionForm action={removeShipmentReceiptAction.bind(null, shipment.id, receipt.id, loadedAt)} submitLabel={`Take ${receipt.number} off`} compact />
                </div>
              ))}
              {shipment.receiptsToAdd.length > 0 ? (
                <ActionForm action={addShipmentReceiptAction.bind(null, shipment.id, loadedAt)} submitLabel="Put these goods on the shipment" className="flex max-w-md flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="receiptId" className="text-sm font-medium">
                      Goods received note
                    </label>
                    <select id="receiptId" name="receiptId" defaultValue="" required className={SELECT}>
                      <option value="">Choose a goods received note from this supplier</option>
                      {shipment.receiptsToAdd.map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </ActionForm>
              ) : (
                <p className="text-sm text-muted-foreground">No other goods received from this supplier are waiting to go on a shipment.</p>
              )}
            </div>
          ) : null}
        </Card>

        <Card title="Charges">
          {shipment.charges.length === 0 ? (
            <Empty>No charges are on this shipment yet.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table aria-label="Charges on the shipment" className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Bill</th>
                    <th className="py-2 pr-4 font-medium">Billed by</th>
                    <th className="py-2 pr-4 font-medium">Charge</th>
                    <th className="py-2 pr-4 font-medium">Kind</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 font-medium">Spread</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shipment.charges.map((charge) => (
                    <tr key={charge.id}>
                      <td className="py-2 pr-4 font-medium whitespace-nowrap">
                        {can(session.role, "supplier_bill.read") ? (
                          <Link href={`/purchases/bills/${charge.billId}`} className="underline-offset-4 hover:underline">
                            {charge.billNumber}
                          </Link>
                        ) : (
                          charge.billNumber
                        )}
                      </td>
                      <td className="py-2 pr-4">{charge.billedBy}</td>
                      <td className="py-2 pr-4">{charge.description}</td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {CHARGE_CLASS_LABELS[charge.class]}
                        {charge.basis ? `, ${CHARGE_BASIS_LABELS[charge.basis].toLowerCase()}` : ""}
                        {charge.accountName ? `: ${charge.accountName}` : ""}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(charge.amount)}</td>
                      <td className="py-2">
                        {charge.allocationId ? (
                          <Pill label="Spread" strong />
                        ) : manage ? (
                          <ActionForm action={removeShipmentChargeAction.bind(null, shipment.id, charge.id, loadedAt)} submitLabel="Take off" compact />
                        ) : (
                          <Pill label="Waiting" strong={false} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {manage ? (
            <div className="mt-4">
              {shipment.billLinesToAdd.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No bill line charged to Goods in transit is waiting to go on a shipment. Enter the freight, duty or clearing bill under Supplier bills, with Goods in transit as the account of each line.
                </p>
              ) : (
                <ChargeForm
                  action={addShipmentChargeAction.bind(null, shipment.id, loadedAt)}
                  billLines={shipment.billLinesToAdd.map((line) => ({ billLineId: line.billLineId, label: line.label, amount: line.amount.toFixed(2) }))}
                  classes={CHARGE_CLASSES.map((kind) => ({ id: kind, label: CHARGE_CLASS_LABELS[kind] }))}
                  bases={CHARGE_BASES.map((basis) => ({ id: basis, label: CHARGE_BASIS_LABELS[basis] }))}
                  depositAccounts={shipment.depositAccounts}
                  expenseAccounts={shipment.expenseAccounts}
                />
              )}
            </div>
          ) : null}
        </Card>

        {manage && waiting.length > 0 ? (
          <Card title={open ? "Close the shipment and spread its charges" : "Spread the charges that came later"}>
            {shipment.goods.length === 0 ? (
              <p className="text-sm text-muted-foreground">Put the goods on the shipment first: charges are spread over them.</p>
            ) : shipment.preview && !shipment.preview.ok ? (
              <p role="alert" className="text-sm text-destructive">
                {shipment.preview.reason}
              </p>
            ) : (
              <>
                {preview ? (
                  <dl className="mb-4 grid max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">Added to the stock still held</dt>
                    <dd className="text-right tabular-nums" data-testid="spread-to-stock">
                      {formatAmount(preview.toStock)}
                    </dd>
                    <dt className="text-muted-foreground">To cost of goods sold, for goods already gone</dt>
                    <dd className="text-right tabular-nums" data-testid="spread-to-cogs">
                      {formatAmount(preview.toCogs)}
                    </dd>
                    {(
                      [
                        ["Sales tax paid at import", preview.salesTax],
                        ["Income tax paid at import", preview.advanceIncomeTax],
                        ["Deposits", preview.deposits],
                        ["Expenses", preview.expenses],
                      ] as const
                    )
                      .filter(([, amount]) => !amount.isZero())
                      .map(([label, amount]) => (
                        <div key={label} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="text-right tabular-nums">{formatAmount(amount)}</dd>
                        </div>
                      ))}
                    <dt className="font-medium">Taken out of Goods in transit</dt>
                    <dd className="text-right font-medium tabular-nums" data-testid="spread-total">
                      {formatAmount(preview.total)}
                    </dd>
                  </dl>
                ) : null}
                <p className="mb-3 text-sm text-muted-foreground">
                  {open ? "Closing fixes what goes on the shipment's goods: goods can no longer be put on it or taken off. " : ""}Spreading cannot be undone. A charge that comes later is spread on its own, the same way.
                </p>
                <ActionForm action={allocateShipmentAction.bind(null, shipment.id, loadedAt)} submitLabel={open ? "Close shipment and spread charges" : "Spread these charges"} className="flex max-w-[12rem] flex-col gap-3">
                  <Field label="On" name="date" id="spread-date" type="date" defaultValue={todayIso(new Date())} required />
                </ActionForm>
              </>
            )}
          </Card>
        ) : null}

        {shipment.allocations.length > 0 ? (
          <Card title="Charges spread">
            <div className="overflow-x-auto">
              <table aria-label="Charges spread" className="w-full min-w-[620px] text-left text-sm">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-4 font-medium">On</th>
                    <th className="py-2 pr-4 text-right font-medium">Charges</th>
                    <th className="py-2 pr-4 text-right font-medium">Into stock</th>
                    <th className="py-2 pr-4 text-right font-medium">To cost of goods sold</th>
                    <th className="py-2 pr-4 text-right font-medium">In all</th>
                    <th className="py-2 font-medium">In the books</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {shipment.allocations.map((run) => (
                    <tr key={run.id}>
                      <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(run.date)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{run.charges}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(run.toStock)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(run.toCogs)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{formatAmount(run.total)}</td>
                      <td className="py-2">
                        {can(session.role, "journal.read") ? (
                          <Link href={`/journals/${run.journalId}`} className="underline-offset-4 hover:underline">
                            See the journal
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : null}

        {manage && open && shipment.receipts.length === 0 && shipment.charges.length === 0 ? (
          <Card title="Cancel this shipment">
            <p className="mb-3 text-sm text-muted-foreground">For a shipment opened by mistake. It keeps its number, marked cancelled, with the reason.</p>
            <ActionForm action={cancelShipmentAction.bind(null, shipment.id, loadedAt)} submitLabel="Cancel shipment" className="max-w-md">
              <Field label="Reason" name="reason" required maxLength={300} autoComplete="off" placeholder="Such as: opened twice" />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}
