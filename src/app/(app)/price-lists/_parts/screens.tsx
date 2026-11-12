import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { formatIsoDate } from "@/modules/currencies/rules";
import { getPriceList, listItemPrices, listPriceLists, type PriceRow } from "@/modules/prices/queries";
import { can, type MemberRole, type ModuleState } from "@/modules/tenant/rules";
import { createPriceListAction, setClassPriceAction, setCustomerPriceAction, setDefaultPriceListAction, setListPriceAction } from "./actions";

/** Why this person may not open the price screens, or null when they may. Prices belong to Sales. */
function refusal(session: { role: MemberRole; modules: ModuleState }): string | null {
  if (!session.modules.sales) return "Price lists are part of Sales, which is switched off for this company.";
  return can(session.role, "price.read") ? null : "Your role does not include prices.";
}

function Refused({ reason }: { reason: string }) {
  return (
    <>
      <PageHead title="Price lists" />
      <p className="text-muted-foreground">{reason}</p>
    </>
  );
}

function Pill({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className={on ? "rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground" : "rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"}>
      {children}
    </span>
  );
}

/** A table of dated prices. `first` names what each row is for: the item, the list, the class or the customer. */
export function PriceTable({ label, first, rows, today, showItem }: { label: string; first: string; rows: PriceRow[]; today: string; showItem: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table aria-label={label} className="w-full min-w-[520px] text-left text-sm">
        <thead className="border-b text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 font-medium">{first}</th>
            <th className="py-2 pr-4 text-right font-medium">Price</th>
            <th className="py-2 pr-4 font-medium">From</th>
            <th className="py-2 pr-4 font-medium">Until</th>
            <th className="py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-4">{showItem ? <><span className="font-medium">{row.itemCode}</span> {row.itemName}</> : row.label}</td>
              <td className="py-2 pr-4 text-right whitespace-nowrap">{formatAmount(row.price)}</td>
              <td className="py-2 pr-4 whitespace-nowrap">{formatIsoDate(row.validFrom)}</td>
              <td className="py-2 pr-4 whitespace-nowrap">{row.validTo ? formatIsoDate(row.validTo) : ""}</td>
              <td className="py-2 whitespace-nowrap">
                <Pill on={row.inForce}>{row.inForce ? "In force" : row.validFrom > today ? "Not yet" : row.validTo !== null && row.validTo < today ? "Ended" : "Not in force"}</Pill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PriceFields({ prefix, today }: { prefix: string; today: string }) {
  return (
    <>
      <Field id={`${prefix}-price`} label="Price" name="price" inputMode="decimal" required autoComplete="off" hint="For one of the item's own unit, without commas." />
      <Field id={`${prefix}-from`} label="From date" name="validFrom" type="date" defaultValue={today} required />
      <Field id={`${prefix}-until`} label="Until date" name="validTo" type="date" hint="The last day it applies. Leave empty for no end." />
    </>
  );
}

export async function PriceListsScreen() {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  const lists = await listPriceLists(session);
  return (
    <>
      <PageHead title="Price lists" />
      <div className="grid max-w-4xl gap-5 md:grid-cols-[2fr_1fr]">
        <Card>
          <p className="mb-2 text-sm text-muted-foreground">
            A customer pays their own price for an item if they have one, else the price for their class, else the price on their
            list, else the item&apos;s selling price. A customer on no list uses the default list.
          </p>
          {lists.length === 0 ? (
            <Empty>No price lists yet.</Empty>
          ) : (
            <table aria-label="Price lists" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 text-right font-medium">Prices</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {lists.map((list) => (
                  <tr key={list.id}>
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`/price-lists/${list.id}`} className="underline-offset-4 hover:underline">
                        {list.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4 text-right">{list.prices}</td>
                    <td className="py-2">{list.isDefault ? <Pill on>Default</Pill> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {can(session.role, "price.manage") ? (
          <Card title="Add a price list">
            <ActionForm action={createPriceListAction} submitLabel="Add price list">
              <Field label="Name" name="name" required maxLength={60} hint="Such as Wholesale 2026." />
            </ActionForm>
          </Card>
        ) : null}
      </div>
    </>
  );
}

export async function PriceListScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  const { id } = await params;
  const today = todayIso(new Date());
  const list = await getPriceList(session, id, today);
  if (!list) notFound();
  const manager = can(session.role, "price.manage");
  return (
    <>
      <PageHead
        title={list.name}
        sub={
          <>
            <Link href="/price-lists">Back to price lists</Link>
            {list.isDefault ? <span data-testid="default-note"> · The default list</span> : null}
          </>
        }
      />
      <div className="flex max-w-4xl flex-col gap-5">
        <Card title="Prices">
          {list.prices.length === 0 ? <Empty>No prices on this list yet.</Empty> : <PriceTable label="Prices" first="Item" rows={list.prices} today={today} showItem />}
          {list.more ? <p className="mt-3 text-sm text-muted-foreground">Showing the first 500 prices.</p> : null}
        </Card>
        {manager ? (
          <div className="grid gap-5 md:grid-cols-2">
            <Card title="Set a price">
              <ActionForm action={setListPriceAction.bind(null, list.id)} submitLabel="Save price">
                <Field id="list-item" label="Item code" name="item" required maxLength={30} autoComplete="off" />
                <PriceFields prefix="list" today={today} />
              </ActionForm>
            </Card>
            {list.isDefault ? null : (
              <Card title="Default list">
                <p className="mb-3 text-sm text-muted-foreground">The default list is used for customers who are on no list.</p>
                <ActionForm action={setDefaultPriceListAction.bind(null, list.id)} submitLabel="Make this the default" compact />
              </Card>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

/** The card on an item's own screen: every special price it has, and the forms to add one. */
export async function ItemPricesCard({ itemId }: { itemId: string }) {
  const session = await requireTenant();
  if (!session.modules.sales || !can(session.role, "price.read")) return null;
  const today = todayIso(new Date());
  const { lists, classes, customers } = await listItemPrices(session, itemId, today);
  const manager = can(session.role, "price.manage");
  return (
    <Card title="Special prices">
      <p className="mb-2 text-sm text-muted-foreground">
        A customer&apos;s own price wins, then the price for their class, then their price list, then the selling price above.
      </p>
      {lists.length + classes.length + customers.length === 0 ? <Empty>No special prices.</Empty> : null}
      <div className="flex flex-col gap-4">
        {customers.length > 0 ? <PriceTable label="Customer prices" first="Customer" rows={customers} today={today} showItem={false} /> : null}
        {classes.length > 0 ? <PriceTable label="Class prices" first="Customer class" rows={classes} today={today} showItem={false} /> : null}
        {lists.length > 0 ? <PriceTable label="Price list prices" first="Price list" rows={lists} today={today} showItem={false} /> : null}
      </div>
      {manager ? (
        <div className="mt-4 grid gap-5 border-t pt-4 md:grid-cols-2">
          <ActionForm action={setClassPriceAction.bind(null, itemId)} submitLabel="Save class price">
            <Field id="class-name" label="Customer class" name="customerClass" required maxLength={40} hint="Such as Wholesale." />
            <PriceFields prefix="class" today={today} />
          </ActionForm>
          <ActionForm action={setCustomerPriceAction.bind(null, itemId)} submitLabel="Save customer price">
            <Field id="customer-name" label="Customer" name="customer" required maxLength={120} hint="The customer's code or exact name." />
            <PriceFields prefix="customer" today={today} />
          </ActionForm>
        </div>
      ) : null}
    </Card>
  );
}
