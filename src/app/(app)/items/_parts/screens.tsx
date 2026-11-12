import Decimal from "decimal.js";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { logFailure } from "@/lib/errors";
import { formatAmount } from "@/lib/money";
import { ITEM_LIST_LIMIT, getItem, getItemSetup, listItems, type Named, type StoredItem } from "@/modules/items/queries";
import { ITEM_COLUMNS, ITEM_IMPORT_MAX_BYTES, ITEM_IMPORT_MAX_ROWS, type ItemInput } from "@/modules/items/rules";
import { can, type MemberRole, type ModuleState } from "@/modules/tenant/rules";
import { ImportForm } from "../../_parties/import-form";
import { ItemPricesCard } from "../../price-lists/_parts/screens";
import { addItemCategoryAction, addUnitAction, archiveItemAction, importItemsAction, removeItemUnitAction, saveItemAction, setItemUnitAction } from "./actions";

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

/** Why this person may not open the item screens, or null when they may. Items belong to Stock. */
function refusal(session: { role: MemberRole; modules: ModuleState }): string | null {
  if (!session.modules.inventory) return "Items are part of Stock, which is switched off for this company.";
  return can(session.role, "item.read") ? null : "Your role does not include the item list.";
}

function Refused({ reason }: { reason: string }) {
  return (
    <>
      <PageHead title="Items" />
      <p className="text-muted-foreground">{reason}</p>
    </>
  );
}

/** A stored amount or quantity as a person would type it: no trailing zeros. */
const plain = (value: string | null) => (value === null ? "" : new Decimal(value).toFixed());
/** A quantity for showing: no trailing zeros. */
const quantity = (value: Decimal) => value.toFixed();

// ── The list ────────────────────────────────────────────────────────────────────────────────────

export async function ItemListScreen({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  const query = await searchParams;
  const search = typeof query.q === "string" ? query.q : "";
  const archived = query.archived === "1";
  let listed: Awaited<ReturnType<typeof listItems>>;
  try {
    listed = await listItems(session, { search, archived });
  } catch (error) {
    logFailure("list items", error);
    return <Refused reason="The list could not be loaded. Please try again." />;
  }
  const { rows, more } = listed;
  const manager = can(session.role, "item.manage");

  return (
    <>
      <PageHead title={archived ? "Archived items" : "Items"} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form method="get" action="/items" role="search" className="flex min-w-0 flex-1 gap-2">
          <input
            name="q"
            defaultValue={search}
            aria-label="Search items"
            placeholder="Code, name or category"
            className="h-8 w-full max-w-72 min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm"
          />
          {archived ? <input type="hidden" name="archived" value="1" /> : null}
          <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Search
          </button>
        </form>
        <Link href={archived ? "/items" : "/items?archived=1"} className="text-sm text-muted-foreground underline underline-offset-4">
          {archived ? "Current items" : "Archived"}
        </Link>
        <Link href="/items/units" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Units and categories
        </Link>
        {manager ? (
          <>
            <Link href="/items/import" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Import
            </Link>
            <Link href="/items/new" className={buttonVariants({ size: "sm" })}>
              New item
            </Link>
          </>
        ) : null}
      </div>
      <Card>
        {rows.length === 0 ? (
          <Empty>{search ? `No item matches "${search}".` : archived ? "No archived items." : "No items yet."}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label="Items" className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">Unit</th>
                  <th className="py-2 pr-4 text-right font-medium">Selling price</th>
                  <th className="py-2 pr-4 text-right font-medium">Retail price</th>
                  <th className="py-2 text-right font-medium">Reorder level</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 font-medium whitespace-nowrap">
                      <Link href={`/items/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.code}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{row.name}</td>
                    <td className="py-2 pr-4">{row.category}</td>
                    <td className="py-2 pr-4">{row.unit}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap">{row.defaultPrice ? formatAmount(row.defaultPrice) : ""}</td>
                    <td className="py-2 pr-4 text-right whitespace-nowrap">{row.retailPrice ? formatAmount(row.retailPrice) : ""}</td>
                    <td className="py-2 text-right whitespace-nowrap">{row.reorderLevel ? quantity(row.reorderLevel) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? <p className="mt-3 text-sm text-muted-foreground">Showing the first {ITEM_LIST_LIMIT}. Search to find the rest.</p> : null}
      </Card>
    </>
  );
}

// ── The form ────────────────────────────────────────────────────────────────────────────────────

function Choice({ id, label, name, value, options, blank, hint }: { id?: string; label: string; name: string; value: string | null; options: Named[]; blank?: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id ?? name}>{label}</Label>
      <select id={id ?? name} name={name} defaultValue={value ?? ""} required={blank === undefined} className={SELECT}>
        {blank !== undefined ? <option value="">{blank}</option> : <option value="" disabled>Choose</option>}
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.code ? `${option.name} (${option.code})` : option.name}
          </option>
        ))}
      </select>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

type Setup = Awaited<ReturnType<typeof getItemSetup>>;

function ItemForm({ id, item, loadedAt, setup }: { id: string | null; item: ItemInput | null; loadedAt?: Date; setup: Setup }) {
  const unit = setup.units.find((u) => u.id === item?.baseUnitId);
  return (
    <ActionForm action={saveItemAction.bind(null, id)} submitLabel={id === null ? "Add item" : "Save changes"}>
      {/* Which version of the item this form shows, so a save over a newer one is refused. */}
      {loadedAt ? <input type="hidden" name="loadedAt" value={loadedAt.toISOString()} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Code" name="code" defaultValue={item?.code ?? ""} required maxLength={30} autoComplete="off" hint="What is typed to pick the item, such as BP-100." />
        <Field label="Name" name="name" defaultValue={item?.name ?? ""} required maxLength={160} />
        <Choice label="Category" name="category" value={item?.categoryId ?? null} options={setup.categories} blank="None" />
        {id === null ? (
          <Choice label="Unit" name="unit" value={null} options={setup.units} hint="What the item is counted in. It cannot be changed later." />
        ) : (
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Unit</span>
            <span data-testid="item-unit" className="py-1.5">
              {unit ? `${unit.name} (${unit.code})` : ""}
            </span>
            <span className="text-xs text-muted-foreground">Stock is counted in it, so it cannot be changed.</span>
          </div>
        )}
        <Field label="Selling price" name="defaultPrice" defaultValue={plain(item?.defaultPrice ?? null)} inputMode="decimal" autoComplete="off" hint="For one of the item's own unit, when no price list or special price applies." />
        <Field label="Retail price" name="retailPrice" defaultValue={plain(item?.retailPrice ?? null)} inputMode="decimal" autoComplete="off" hint="The price printed on the pack, without commas." />
        <Field label="Reorder level" name="reorderLevel" defaultValue={plain(item?.reorderLevel ?? null)} inputMode="decimal" autoComplete="off" hint="Stock at or below this asks to be reordered." />
      </div>
      {id === null ? (
        <>
          <h3 className="mt-2 text-sm font-bold">Also bought or sold by the pack</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Choice label="Pack unit" name="packUnit" value={null} options={setup.units} blank="None" />
            <Field label="Units per pack" name="packSize" inputMode="decimal" autoComplete="off" hint="How many of the item's own unit one pack holds, such as 24." />
          </div>
        </>
      ) : null}
      <h3 className="mt-2 text-sm font-bold">Tax and customs</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Choice label="Tax category" name="taxCategory" value={item?.taxCategoryId ?? null} options={setup.taxCategories} blank="Not set" />
        <Field label="HS code" name="hsCode" defaultValue={item?.hsCode ?? ""} autoComplete="off" hint="4 to 10 digits, such as 8714.1090." />
        <Field label="FBR unit code" name="fbrUomCode" defaultValue={item?.fbrUomCode ?? ""} maxLength={40} autoComplete="off" />
        <Field label="Sale type" name="saleType" defaultValue={item?.saleType ?? ""} maxLength={60} autoComplete="off" />
      </div>
      <h3 className="mt-2 text-sm font-bold">Shipping and tracking</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Weight" name="weight" defaultValue={plain(item?.weight ?? null)} inputMode="decimal" autoComplete="off" hint="Kilograms for one of the item's own unit." />
        <Field label="Volume" name="volume" defaultValue={plain(item?.volume ?? null)} inputMode="decimal" autoComplete="off" hint="Cubic metres for one of the item's own unit." />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="trackBatches" defaultChecked={item?.trackBatches ?? false} className="size-4" />
          Track batches
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="trackSerials" defaultChecked={item?.trackSerials ?? false} className="size-4" />
          Track serial numbers
        </label>
      </div>
    </ActionForm>
  );
}

export async function ItemNewScreen() {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  if (!can(session.role, "item.manage")) {
    return (
      <>
        <PageHead title="New item" sub={<Link href="/items">Back to items</Link>} />
        <p className="text-muted-foreground">Your role cannot add an item.</p>
      </>
    );
  }
  const setup = await getItemSetup(session);
  return (
    <>
      <PageHead title="New item" sub={<Link href="/items">Back to items</Link>} />
      {setup.units.length === 0 ? (
        <p>
          Add a unit first, such as Piece, under <Link href="/items/units" className="underline underline-offset-4">Units and categories</Link>.
        </p>
      ) : (
        <Card className="max-w-3xl">
          <ItemForm id={null} item={null} setup={setup} />
        </Card>
      )}
    </>
  );
}

// ── One item ────────────────────────────────────────────────────────────────────────────────────

function Units({ found, setup, manager }: { found: StoredItem; setup: Setup; manager: boolean }) {
  const base = setup.units.find((u) => u.id === found.item.baseUnitId);
  const others = setup.units.filter((u) => u.id !== found.item.baseUnitId);
  return (
    <Card title="Units">
      <p className="mb-2 text-sm text-muted-foreground">
        Counted in {base?.name.toLowerCase()} ({base?.code}). A line entered in another unit is turned into {base?.code} by the number here.
      </p>
      {found.conversions.length === 0 ? (
        <Empty>No other units.</Empty>
      ) : (
        <table aria-label="Other units" className="w-full text-left text-sm">
          <tbody className="divide-y">
            {found.conversions.map((c) => (
              <tr key={c.unitId}>
                <td className="py-2 pr-4">
                  1 {c.name.toLowerCase()} ({c.code}) = {quantity(c.factor)} {base?.code}
                </td>
                <td className="py-2 text-right">
                  {manager && found.archivedAt === null ? <ActionForm action={removeItemUnitAction.bind(null, found.id, c.unitId)} submitLabel={`Remove ${c.code}`} compact /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {manager && found.archivedAt === null && others.length > 0 ? (
        <div className="mt-4 border-t pt-4">
          <ActionForm action={setItemUnitAction.bind(null, found.id)} submitLabel="Save unit">
            <div className="grid gap-4 md:grid-cols-2">
              <Choice id="unit-other" label="Other unit" name="unit" value={null} options={others} />
              <Field id="unit-factor" label={`How many ${base?.code} it holds`} name="factor" inputMode="decimal" required autoComplete="off" hint="Such as 24. Saving a unit again corrects its number." />
            </div>
          </ActionForm>
        </div>
      ) : null}
    </Card>
  );
}

function Summary({ item, setup }: { item: ItemInput; setup: Setup }) {
  const name = (list: Named[], id: string | null) => list.find((entry) => entry.id === id)?.name ?? null;
  const facts: [string, string | null][] = [
    ["Code", item.code],
    ["Category", name(setup.categories, item.categoryId)],
    ["Unit", name(setup.units, item.baseUnitId)],
    ["Selling price", item.defaultPrice === null ? null : formatAmount(new Decimal(item.defaultPrice))],
    ["Retail price", item.retailPrice === null ? null : formatAmount(new Decimal(item.retailPrice))],
    ["Reorder level", item.reorderLevel === null ? null : plain(item.reorderLevel)],
    ["Tax category", name(setup.taxCategories, item.taxCategoryId)],
    ["HS code", item.hsCode],
    ["FBR unit code", item.fbrUomCode],
    ["Sale type", item.saleType],
    ["Weight", item.weight === null ? null : `${plain(item.weight)} kg`],
    ["Volume", item.volume === null ? null : `${plain(item.volume)} cubic metres`],
    ["Tracking", [item.trackBatches ? "batches" : "", item.trackSerials ? "serial numbers" : ""].filter(Boolean).join(" and ") || null],
  ];
  return (
    <dl aria-label="Details" className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
      {facts
        .filter(([, value]) => value !== null && value !== "")
        .map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export async function ItemDetailScreen({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  const { id } = await params;
  const [found, setup] = await Promise.all([getItem(session, id), getItemSetup(session)]);
  if (!found) notFound();
  const manager = can(session.role, "item.manage");
  const archived = found.archivedAt !== null;
  return (
    <>
      <PageHead
        title={found.item.name}
        sub={
          <>
            <Link href="/items">Back to items</Link>
            {archived ? <span data-testid="archived-note"> · Archived</span> : null}
          </>
        }
      />
      <div className="flex max-w-3xl flex-col gap-5">
        {manager && !archived ? (
          <Card title="Change this item">
            <ItemForm id={found.id} item={found.item} loadedAt={found.updatedAt} setup={setup} />
          </Card>
        ) : (
          <Card title="Details">
            <Summary item={found.item} setup={setup} />
          </Card>
        )}
        <Units found={found} setup={setup} manager={manager} />
        {archived ? null : <ItemPricesCard itemId={found.id} />}
        {manager ? (
          <Card title={archived ? "Restore" : "Archive"}>
            <p className="mb-3 text-sm text-muted-foreground">
              {archived ? "Restoring puts this item back in the list and lets it be changed again." : "Archiving hides this item from the list. Nothing is deleted, and it can be restored at any time."}
            </p>
            <ActionForm action={archiveItemAction.bind(null, found.id, !archived)} submitLabel={archived ? "Restore item" : "Archive item"} compact />
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── Units and categories ────────────────────────────────────────────────────────────────────────

export async function ItemUnitsScreen() {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  const setup = await getItemSetup(session);
  const manager = can(session.role, "item.manage");
  return (
    <>
      <PageHead title="Units and categories" sub={<Link href="/items">Back to items</Link>} />
      <div className="grid max-w-4xl gap-5 md:grid-cols-2">
        <Card title="Units">
          {setup.units.length === 0 ? (
            <Empty>No units yet.</Empty>
          ) : (
            <ul aria-label="Units" className="mb-4 divide-y text-sm">
              {setup.units.map((unit) => (
                <li key={unit.id} className="py-2">
                  {unit.name} <span className="text-muted-foreground">({unit.code})</span>
                </li>
              ))}
            </ul>
          )}
          {manager ? (
            <ActionForm action={addUnitAction} submitLabel="Add unit">
              <Field id="unit-name" label="Unit name" name="name" required maxLength={40} hint="Such as Piece or Carton." />
              <Field id="unit-code" label="Short form" name="code" required maxLength={10} hint="Shown beside a quantity, such as pc or ctn." />
            </ActionForm>
          ) : null}
        </Card>
        <Card title="Categories">
          {setup.categories.length === 0 ? (
            <Empty>No categories yet.</Empty>
          ) : (
            <ul aria-label="Categories" className="mb-4 divide-y text-sm">
              {setup.categories.map((category) => (
                <li key={category.id} className="py-2">
                  {category.name}
                </li>
              ))}
            </ul>
          )}
          {manager ? (
            <ActionForm action={addItemCategoryAction} submitLabel="Add category">
              <Field id="category-name" label="Category name" name="name" required maxLength={60} hint="Such as Engine parts." />
            </ActionForm>
          ) : null}
        </Card>
      </div>
    </>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

export async function ItemImportScreen() {
  const session = await requireTenant();
  const refused = refusal(session);
  if (refused) return <Refused reason={refused} />;
  return (
    <>
      <PageHead title="Import items" sub={<Link href="/items">Back to items</Link>} />
      {can(session.role, "item.manage") ? (
        <Card className="max-w-3xl">
          <div className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Save your list as a CSV file. The first row names the columns; each row after it is one item. Code, Name and Unit are
              needed. Up to {ITEM_IMPORT_MAX_ROWS.toLocaleString("en")} rows at a time.
            </p>
            <p>
              Columns the import knows: <span data-testid="import-columns">{ITEM_COLUMNS.map((column) => column.header).join(", ")}</span>.
            </p>
            <p>
              Units, categories and tax categories are matched by name and must exist already. Pack unit and Units per pack give the
              item a second unit, such as a carton of 24.
            </p>
            <p>If any row is wrong, nothing is imported and the rows to correct are listed here.</p>
          </div>
          <ImportForm action={importItemsAction} many="items" maxBytes={ITEM_IMPORT_MAX_BYTES} />
        </Card>
      ) : (
        <p className="text-muted-foreground">Your role cannot import items.</p>
      )}
    </>
  );
}
