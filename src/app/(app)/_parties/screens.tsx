import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { Field } from "@/components/field";
import { Card, Empty, PageHead } from "@/components/page-parts";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { requireTenant } from "@/lib/auth/session";
import { logFailure } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { formatAmount } from "@/lib/money";
import { PARTY_LIST_LIMIT, getParty, listParties } from "@/modules/parties/queries";
import { listPriceLists } from "@/modules/prices/queries";
import {
  ATL_LABELS,
  ATL_STATUSES,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  PARTY_MODULE,
  PARTY_WORDS,
  PROVINCES,
  PROVINCE_LABELS,
  REGISTRATION_LABELS,
  REGISTRATION_TYPES,
  SUPPLIER_TYPES,
  SUPPLIER_TYPE_LABELS,
  importColumns,
  type PartyInput,
  type PartyKind,
} from "@/modules/parties/rules";
import { MODULE_INFO, can, type MemberRole, type ModuleState } from "@/modules/tenant/rules";
import Decimal from "decimal.js";
import { archivePartyAction, importPartiesAction, savePartyAction } from "./actions";
import { ImportForm } from "./import-form";

// The screens for customers and for suppliers are the same screens; `kind` says which.

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";
const NO_ACCESS: Record<PartyKind, string> = {
  customer: "Your role does not include the customer list.",
  supplier: "Your role does not include the supplier list.",
};
const canRead = (role: MemberRole, kind: PartyKind) => can(role, kind === "customer" ? "customer.read" : "supplier.read");
const canManage = (role: MemberRole, kind: PartyKind) => can(role, kind === "customer" ? "customer.manage" : "supplier.manage");

// Customers belong to Sales and suppliers to Purchases. A module that is off is invisible: no
// menu entry, and its screens say so instead of opening.

/** Why this person may not open the screen, or null when they may. */
function refusal(session: { role: MemberRole; modules: ModuleState }, kind: PartyKind): string | null {
  const owning = PARTY_MODULE[kind];
  if (!session.modules[owning]) {
    return `${PARTY_WORDS[kind].many} are part of ${MODULE_INFO[owning].label}, which is switched off for this company.`;
  }
  return canRead(session.role, kind) ? null : NO_ACCESS[kind];
}

function Refused({ kind, reason }: { kind: PartyKind; reason: string }) {
  return (
    <>
      <PageHead title={PARTY_WORDS[kind].many} />
      <p className="text-muted-foreground">{reason}</p>
    </>
  );
}

// ── The list ────────────────────────────────────────────────────────────────────────────────────

export async function PartyListScreen({ kind, searchParams }: { kind: PartyKind; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireTenant();
  const refused = refusal(session, kind);
  if (refused) return <Refused kind={kind} reason={refused} />;
  const query = await searchParams;
  const search = typeof query.q === "string" ? query.q : "";
  const archived = query.archived === "1";
  const { one, many, path } = PARTY_WORDS[kind];
  let listed: Awaited<ReturnType<typeof listParties>>;
  try {
    listed = await listParties(session, kind, { search, archived });
  } catch (error) {
    // Logged without the query or what was searched for, which can be a phone number.
    logFailure(`list ${many.toLowerCase()}`, error);
    return <Refused kind={kind} reason="The list could not be loaded. Please try again." />;
  }
  const { rows, more } = listed;
  const customer = kind === "customer";

  return (
    <>
      <PageHead title={archived ? `Archived ${many.toLowerCase()}` : many} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form method="get" action={path} role="search" className="flex min-w-0 flex-1 gap-2">
          <input
            name="q"
            defaultValue={search}
            aria-label={`Search ${many.toLowerCase()}`}
            placeholder="Name, code, city or phone"
            className="h-8 w-full max-w-72 min-w-0 rounded-lg border border-input bg-card px-2.5 text-sm"
          />
          {archived ? <input type="hidden" name="archived" value="1" /> : null}
          <button type="submit" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Search
          </button>
        </form>
        <Link href={archived ? path : `${path}?archived=1`} className="text-sm text-muted-foreground underline underline-offset-4">
          {archived ? `Current ${many.toLowerCase()}` : "Archived"}
        </Link>
        {canManage(session.role, kind) ? (
          <>
            <Link href={`${path}/import`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Import
            </Link>
            <Link href={`${path}/new`} className={buttonVariants({ size: "sm" })}>
              New {one}
            </Link>
          </>
        ) : null}
      </div>

      <Card>
        {rows.length === 0 ? (
          <Empty>{search ? `No ${one} matches "${search}".` : archived ? `No archived ${many.toLowerCase()}.` : `No ${many.toLowerCase()} yet.`}</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table aria-label={many} className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Code</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">{customer ? "Class" : "Type"}</th>
                  <th className="py-2 pr-4 font-medium">City</th>
                  <th className="py-2 pr-4 font-medium">Phone</th>
                  {customer ? <th className="py-2 pr-4 text-right font-medium">Credit limit</th> : null}
                  <th className="py-2 text-right font-medium">Credit days</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.code}</td>
                    <td className="py-2 pr-4 font-medium">
                      <Link href={`${path}/${row.id}`} className="underline-offset-4 hover:underline">
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">{customer ? row.customerClass : row.supplierType ? SUPPLIER_TYPE_LABELS[row.supplierType] : ""}</td>
                    <td className="py-2 pr-4">{row.city}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{row.phone}</td>
                    {customer ? <td className="py-2 pr-4 text-right whitespace-nowrap">{row.creditLimit ? formatAmount(row.creditLimit) : ""}</td> : null}
                    <td className="py-2 text-right">{row.creditDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {more ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Showing the first {PARTY_LIST_LIMIT}. Search to find the rest.
          </p>
        ) : null}
      </Card>
    </>
  );
}

// ── The form ────────────────────────────────────────────────────────────────────────────────────

function Choice({ label, name, value, options, blank }: { label: string; name: string; value: string | null; options: [string, string][]; blank?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select id={name} name={name} defaultValue={value ?? ""} className={SELECT}>
        {blank !== undefined ? <option value="">{blank}</option> : null}
        {options.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

const pairs = <T extends string>(keys: readonly T[], labels: Record<T, string>): [string, string][] => keys.map((key) => [key, labels[key]]);
/** A stored amount as a person would type it: no trailing zeros. */
const plainAmount = (value: string | null) => (value === null ? "" : new Decimal(value).toFixed());

type ListChoice = { id: string; name: string; isDefault: boolean };

/** The price lists a customer can be put on; none when this person may not see prices. */
async function priceListChoices(session: Parameters<typeof listPriceLists>[0], kind: PartyKind): Promise<ListChoice[]> {
  return kind === "customer" && can(session.role, "price.read") ? listPriceLists(session) : [];
}

function PartyForm({ kind, id, party, loadedAt, priceLists }: { kind: PartyKind; id: string | null; party: PartyInput | null; loadedAt?: Date; priceLists: ListChoice[] }) {
  const { one } = PARTY_WORDS[kind];
  return (
    <ActionForm action={savePartyAction.bind(null, kind, id)} submitLabel={id === null ? `Add ${one}` : "Save changes"}>
      {/* Which version of the party this form shows, so a save over a newer one is refused. */}
      {loadedAt ? <input type="hidden" name="loadedAt" value={loadedAt.toISOString()} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" name="name" defaultValue={party?.name ?? ""} required maxLength={120} />
        <Field label="Code" name="code" defaultValue={party?.code ?? ""} maxLength={20} hint="Your own short code, if you use codes." />
        {kind === "supplier" ? (
          <Choice label="Supplier type" name="supplierType" value={party?.supplierType ?? "company"} options={pairs(SUPPLIER_TYPES, SUPPLIER_TYPE_LABELS)} />
        ) : (
          <Field label="Class" name="customerClass" defaultValue={party?.customerClass ?? ""} maxLength={40} hint="Such as Wholesale or Retail." />
        )}
        <Field label="Credit days" name="creditDays" defaultValue={party?.creditDays ?? ""} inputMode="numeric" autoComplete="off" />
        {kind === "customer" && priceLists.length > 0 ? (
          <Choice
            label="Price list"
            name="priceListId"
            value={party?.priceListId ?? null}
            options={priceLists.map((list): [string, string] => [list.id, list.name])}
            blank={`The default list${priceLists.find((list) => list.isDefault) ? ` (${priceLists.find((list) => list.isDefault)!.name})` : ""}`}
          />
        ) : null}
        {kind === "customer" ? (
          <Field
            label="Credit limit"
            name="creditLimit"
            defaultValue={plainAmount(party?.creditLimit ?? null)}
            inputMode="decimal"
            autoComplete="off"
            hint="The most the customer may owe, without commas. Leave empty for no limit."
          />
        ) : null}
      </div>

      <h3 className="mt-2 text-sm font-bold">Tax</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Choice label="Sales tax registration" name="registrationType" value={party?.registrationType ?? "unregistered"} options={pairs(REGISTRATION_TYPES, REGISTRATION_LABELS)} />
        <Field label="STRN" name="strn" defaultValue={party?.strn ?? ""} autoComplete="off" hint="13 digits. Only for a registered party." />
        <Field label="NTN" name="ntn" defaultValue={party?.ntn ?? ""} autoComplete="off" hint="7 digits, with or without the check digit." />
        <Field label="CNIC" name="cnic" defaultValue={party?.cnic ?? ""} autoComplete="off" hint="13 digits." />
        <Choice label="Active Taxpayers List" name="atlStatus" value={party?.atlStatus ?? "unknown"} options={pairs(ATL_STATUSES, ATL_LABELS)} />
        <Choice label="Province" name="province" value={party?.province ?? null} options={pairs(PROVINCES, PROVINCE_LABELS)} blank="Not set" />
        {kind === "customer" ? (
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" name="withholdingAgent" defaultChecked={party?.isWithholdingAgent ?? false} className="size-4" />
            This customer deducts tax when it pays (a withholding agent)
          </label>
        ) : null}
      </div>

      <h3 className="mt-2 text-sm font-bold">Contact and address</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Contact person" name="contactName" defaultValue={party?.contactName ?? ""} maxLength={80} />
        <Field label="Phone" name="phone" defaultValue={party?.phone ?? ""} maxLength={30} inputMode="tel" />
        <Field label="Email" name="email" type="email" defaultValue={party?.email ?? ""} maxLength={254} />
        <Field label="City" name="city" defaultValue={party?.city ?? ""} maxLength={60} />
        <div className="md:col-span-2">
          <Field label="Address" name="address" defaultValue={party?.address ?? ""} maxLength={200} />
        </div>
      </div>
    </ActionForm>
  );
}

export async function PartyNewScreen({ kind }: { kind: PartyKind }) {
  const session = await requireTenant();
  const refused = refusal(session, kind);
  if (refused) return <Refused kind={kind} reason={refused} />;
  const { one, many, path } = PARTY_WORDS[kind];
  return (
    <>
      <PageHead title={`New ${one}`} sub={<Link href={path}>Back to {many.toLowerCase()}</Link>} />
      {canManage(session.role, kind) ? (
        <Card className="max-w-3xl">
          <PartyForm kind={kind} id={null} party={null} priceLists={await priceListChoices(session, kind)} />
        </Card>
      ) : (
        <p className="text-muted-foreground">Your role cannot add a {one}.</p>
      )}
    </>
  );
}

// ── One party ───────────────────────────────────────────────────────────────────────────────────

function Summary({ kind, party, atlCheckedAt }: { kind: PartyKind; party: PartyInput; atlCheckedAt: Date | null }) {
  const facts: [string, string | null][] = [
    ["Code", party.code],
    kind === "customer" ? ["Class", party.customerClass] : ["Supplier type", party.supplierType ? SUPPLIER_TYPE_LABELS[party.supplierType] : null],
    ...(kind === "customer" ? ([["Credit limit", party.creditLimit === null ? "No limit" : formatAmount(new Decimal(party.creditLimit))]] as [string, string][]) : []),
    ["Credit days", party.creditDays === null ? null : String(party.creditDays)],
    ["Sales tax registration", REGISTRATION_LABELS[party.registrationType]],
    ["STRN", party.strn],
    ["NTN", party.ntn],
    ["CNIC", party.cnic],
    ["Active Taxpayers List", atlCheckedAt ? `${ATL_LABELS[party.atlStatus]} (recorded ${formatDateTime(atlCheckedAt)})` : ATL_LABELS[party.atlStatus]],
    ["Province", party.province ? PROVINCE_LABELS[party.province] : null],
    ...(kind === "customer" ? ([["Withholding agent", party.isWithholdingAgent ? "Yes" : "No"]] as [string, string][]) : []),
    ["Contact person", party.contactName],
    ["Phone", party.phone],
    ["Email", party.email],
    ["Address", [party.address, party.city].filter(Boolean).join(", ") || null],
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

export async function PartyDetailScreen({ kind, params }: { kind: PartyKind; params: Promise<{ id: string }> }) {
  const session = await requireTenant();
  const refused = refusal(session, kind);
  if (refused) return <Refused kind={kind} reason={refused} />;
  const { id } = await params;
  const found = await getParty(session, kind, id);
  if (!found) notFound();
  const { one, many, path } = PARTY_WORDS[kind];
  const manager = canManage(session.role, kind);
  const archived = found.archivedAt !== null;

  return (
    <>
      <PageHead
        title={found.party.name}
        sub={
          <>
            <Link href={path}>Back to {many.toLowerCase()}</Link>
            {archived ? <span data-testid="archived-note"> · Archived {formatDateTime(found.archivedAt!)}</span> : null}
          </>
        }
      />
      <div className="flex max-w-3xl flex-col gap-5">
        {manager && !archived ? (
          <Card title={`Change this ${one}`}>
            <PartyForm kind={kind} id={found.id} party={found.party} loadedAt={found.updatedAt} priceLists={await priceListChoices(session, kind)} />
          </Card>
        ) : (
          <Card title="Details">
            <Summary kind={kind} party={found.party} atlCheckedAt={found.atlCheckedAt} />
          </Card>
        )}
        {manager ? (
          <Card title={archived ? "Restore" : "Archive"}>
            <p className="mb-3 text-sm text-muted-foreground">
              {archived
                ? `Restoring puts this ${one} back in the list and lets it be changed again.`
                : `Archiving hides this ${one} from the list. Nothing is deleted, and it can be restored at any time.`}
            </p>
            <ActionForm action={archivePartyAction.bind(null, kind, found.id, !archived)} submitLabel={archived ? `Restore ${one}` : `Archive ${one}`} compact />
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────────────────────────

export async function PartyImportScreen({ kind }: { kind: PartyKind }) {
  const session = await requireTenant();
  const refused = refusal(session, kind);
  if (refused) return <Refused kind={kind} reason={refused} />;
  const { one, many, path } = PARTY_WORDS[kind];
  const columns = importColumns(kind).map((column) => column.header);
  return (
    <>
      <PageHead title={`Import ${many.toLowerCase()}`} sub={<Link href={path}>Back to {many.toLowerCase()}</Link>} />
      {canManage(session.role, kind) ? (
        <Card className="max-w-3xl">
          <div className="mb-4 flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              Save your list as a CSV file. The first row names the columns; each row after it is one {one}. Only the Name column is
              needed. Up to {IMPORT_MAX_ROWS.toLocaleString("en")} rows at a time.
            </p>
            <p>
              Columns the import knows: <span data-testid="import-columns">{columns.join(", ")}</span>.
            </p>
            <p>If any row is wrong, nothing is imported and the rows to correct are listed here.</p>
          </div>
          <ImportForm action={importPartiesAction.bind(null, kind)} many={many.toLowerCase()} maxBytes={IMPORT_MAX_BYTES} />
        </Card>
      ) : (
        <p className="text-muted-foreground">Your role cannot import {many.toLowerCase()}.</p>
      )}
    </>
  );
}
