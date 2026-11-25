import Decimal from "decimal.js";
import Link from "next/link";
import { Card, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { isUuid } from "@/db";
import { requireTenant, type TenantSession } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatQuantity } from "@/modules/inventory/rules";
import { ONLY_BUYERS } from "@/modules/market-purchases/commands";
import { getMarketPurchase, getMarketPurchaseChoices } from "@/modules/market-purchases/queries";
import { NO_TAX_ON_MARKET_PURCHASE, WITHHOLDS_FROM_SUPPLIERS, backToSales, marketPurchaseHref, shortages } from "@/modules/market-purchases/rules";
import { can } from "@/modules/tenant/rules";
import { marketPurchaseAction } from "./market-actions";
import { MarketPurchaseForm } from "./market-form";
import { Back, Refused } from "./screens";

const TITLE = "Quick market purchase";
const SUB = "For goods bought in the market and paid for on the spot. They are in stock at once, at what they cost.";
const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const first = (value: string | string[] | undefined) => list(value)[0] ?? "";

type Query = { item?: string | string[]; quantity?: string | string[]; warehouse?: string | string[]; back?: string | string[] };

/** The one screen of a quick market purchase. Opened from a delivery note that is short, it comes filled in with what is missing. */
export async function MarketPurchaseScreen({ searchParams }: { searchParams: Promise<Query> }) {
  const session = await requireTenant();
  if (!session.modules.purchasing) return <Refused title={TITLE}>Purchasing is switched off for this company.</Refused>;
  if (!can(session.role, "market_purchase.manage")) return <Refused title={TITLE}>{ONLY_BUYERS}</Refused>;
  const [query, choices] = await Promise.all([searchParams, getMarketPurchaseChoices(session)]);
  const back = backToSales(first(query.back));
  const head = (
    <>
      {back ? <Back href={back} label="Back to the delivery" /> : <Back href="/purchases" label="Purchase orders" />}
      <PageHead title={TITLE} sub={SUB} />
    </>
  );
  if (choices.warehouses.length === 0 || choices.items.length === 0 || choices.accounts.length === 0) {
    return (
      <>
        {head}
        <p className="max-w-2xl text-muted-foreground">
          {choices.warehouses.length === 0
            ? "There is no warehouse for the goods to come into yet. Add one under Settings, Warehouses."
            : choices.items.length === 0
              ? "There are no items yet. Add what you sell under Items first."
              : "There is no cash or bank account for the money to come out of. Add one under Chart of accounts."}
        </p>
      </>
    );
  }
  // What the address asks to be filled in: only items and a warehouse of this company, and plain quantities.
  const wanted = list(query.item);
  const quantities = list(query.quantity);
  const lines = wanted.flatMap((itemId, index) => {
    const item = choices.items.find((choice) => choice.id === itemId);
    const quantity = quantities[index] ?? "";
    return item && /^\d{1,12}(\.\d{1,4})?$/.test(quantity) ? [{ itemCode: item.code, unitId: item.units[0]?.id ?? "", quantity, unitCost: "" }] : [];
  });
  const asked = first(query.warehouse);
  const warehouseId = choices.warehouses.some((warehouse) => warehouse.id === asked) ? asked : choices.warehouses.length === 1 ? choices.warehouses[0].id : "";
  return (
    <>
      {head}
      <Card className="max-w-5xl">
        {lines.length > 0 ? (
          <p role="status" data-testid="market-prefilled" className="mb-4 text-sm">
            Filled in with what the delivery is short of. Enter what one cost and who sold it; change the quantity if you bought more.
          </p>
        ) : null}
        <MarketPurchaseForm
          action={marketPurchaseAction.bind(null, back)}
          suppliers={choices.withholds ? [] : choices.suppliers}
          noListReason={choices.withholds ? WITHHOLDS_FROM_SUPPLIERS : choices.suppliers.length === 0 ? "There are no suppliers on your list yet." : undefined}
          warehouses={choices.warehouses}
          items={choices.items}
          accounts={choices.accounts}
          initial={{ date: todayIso(new Date()), warehouseId, lines }}
          taxNote={choices.withholds ? `${NO_TAX_ON_MARKET_PURCHASE} Your company withholds tax from suppliers, so a supplier on your list is bought from with a purchase order and a bill; check whether this seller is one you must withhold from too.` : NO_TAX_ON_MARKET_PURCHASE}
        />
      </Card>
      <p className="mt-4 max-w-3xl text-sm text-muted-foreground">
        One step records what a slow purchase would: a purchase order, the goods received note, the seller&apos;s bill and the payment, each with its own number. Nothing is recorded unless all of it is.
      </p>
    </>
  );
}

/**
 * On a draft delivery note, or a draft invoice that delivers: what it is short of, and the quick
 * market purchase that brings it in. Whoever cannot buy is told who can. Quantities only: the
 * warehouse sees no cost here.
 */
export async function ShortOfStock({
  session,
  documentId,
  warehouseId,
  warehouseName,
  rows,
  bought,
}: {
  session: TenantSession;
  documentId: string;
  warehouseId: string;
  warehouseName: string;
  rows: Parameters<typeof shortages>[0];
  bought?: string | string[];
}) {
  const short = shortages(rows);
  const boughtId = first(bought);
  const purchase = isUuid(boughtId) && can(session.role, "market_purchase.manage") ? await getMarketPurchase(session, boughtId) : null;
  const done = purchase ? (
    <p role="status" data-testid="market-bought" className="text-sm">
      Bought and in stock: goods received note {purchase.receipt?.number}, bill{" "}
      <Link href={`/purchases/bills/${purchase.bill?.id}`} className="font-medium underline underline-offset-4">
        {purchase.bill?.number}
      </Link>
      , paid by {purchase.payment?.number}.{short.length === 0 ? " There is now enough for this document: post it below." : ""}
    </p>
  ) : null;
  if (short.length === 0) return done;
  const buyer = can(session.role, "market_purchase.manage") && session.modules.purchasing;
  const quantity = (value: Decimal, unit: string | null) => `${formatQuantity(value)}${unit ? ` ${unit}` : ""}`;
  // An item sold only by the carton here is still counted in its own unit, which no line names.
  const counted = (unit: string | null) => (unit ? "" : " (counted in the item's own unit)");
  return (
    <Card title={`Short of stock at ${warehouseName}`}>
      <div className="flex flex-col gap-3" data-testid="short-of-stock">
        {done}
        <ul className="list-disc pl-5 text-sm">
          {short.map((item) => (
            <li key={item.itemId}>
              <span className="font-medium">{item.itemCode}</span> {item.description}: {quantity(item.needed, item.unitCode)} needed, {quantity(item.onHand, item.unitCode)} in stock, <span className="font-semibold">{quantity(item.short, item.unitCode)} short</span>
              {counted(item.unitCode)}.
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">Stock never goes below zero, so this cannot be posted as it stands. Bring the quantities down to what is in stock, or bring the missing goods in first.</p>
        {buyer ? (
          <p>
            <Link href={marketPurchaseHref(short, warehouseId, `/sales/${documentId}`)} className={buttonVariants()}>
              Buy the missing goods from the market
            </Link>
          </p>
        ) : session.modules.purchasing ? (
          <p className="text-sm" data-testid="short-who-can-buy">
            If the goods are bought from the market to finish this order, the owner or an accountant records it under Purchases, Quick market purchase. The goods are then in stock and this can be posted.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
