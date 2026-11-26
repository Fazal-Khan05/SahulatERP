import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PageLoading } from "@/components/page-loading";
import { Card } from "@/components/page-parts";
import { requireTenant } from "@/lib/auth/session";
import { todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { IMPORT_FILE_MAX_BYTES } from "@/modules/data-import/file";
import { IMPORT_KINDS, isDataImportKind, type DataImportKind } from "@/modules/data-import/rules";
import { getOpening } from "@/modules/opening/queries";
import { MODULE_INFO, can } from "@/modules/tenant/rules";
import { listWarehouses } from "@/modules/warehouses/queries";
import { ImportScreen } from "../_parts/import-screen";

export const metadata: Metadata = { title: "Import data" };

export default function ImportKindPage({ params }: PageProps<"/settings/import/[kind]">) {
  return (
    <Suspense fallback={<PageLoading />}>
      <ImportKind params={params} />
    </Suspense>
  );
}

/** Where the imported rows are listed, for the kinds that have a list. */
const LISTS: Partial<Record<DataImportKind, string>> = { customers: "/customers", suppliers: "/suppliers", items: "/items" };

async function ImportKind({ params }: { params: Promise<{ kind: string }> }) {
  const session = await requireTenant();
  const { kind } = await params;
  if (!isDataImportKind(kind)) notFound();
  const about = IMPORT_KINDS[kind];
  const back = (
    <Link href="/settings/import" className="text-sm underline">
      Back to Import data
    </Link>
  );
  const refused = !can(session.role, "opening.manage")
    ? "Only an owner or an accountant can import a company's data."
    : about.module && !session.modules[about.module]
      ? `${MODULE_INFO[about.module].label} is switched off for this company.`
      : !can(session.role, about.permission)
        ? `Your role cannot import ${about.many}.`
        : null;
  if (refused) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">{refused}</p>
        {back}
      </div>
    );
  }

  const entry = about.opening || about.stock ? await getOpening(session) : null;
  if (about.opening && entry?.status !== "draft") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          {entry === null || entry.status === "reversed"
            ? "Start the opening entry first: it sets the day the books open here, and these balances go onto it."
            : "The opening balances are posted. To add to them, reverse them first; they come back as a draft."}
        </p>
        <Link href="/settings/opening-balances" className="text-sm underline">
          Go to Opening balances
        </Link>
        {back}
      </div>
    );
  }
  const warehouses = about.stock ? await listWarehouses(session) : [];

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      {back}
      <Card title={`Import ${about.title.toLowerCase()}`}>
        <div className="mb-4 flex flex-col gap-1 text-sm">
          <p>{about.about}</p>
          {about.before ? <p className="text-muted-foreground">{about.before}</p> : null}
          {about.opening && entry ? <p className="text-muted-foreground">They go onto the draft opening entry, dated {formatIsoDate(entry.openingDate)}.</p> : null}
          <p className="text-muted-foreground">
            Template with our headings:{" "}
            <a href={`/settings/import/${kind}/template?format=xlsx`} className="underline">
              Excel
            </a>
            ,{" "}
            <a href={`/settings/import/${kind}/template?format=csv`} className="underline">
              CSV
            </a>
            .
          </p>
        </div>
        <ImportScreen
          kind={kind}
          one={about.one}
          many={about.many}
          columns={about.columns.map((column) => ({ key: column.key, header: column.header, required: column.required }))}
          maxBytes={IMPORT_FILE_MAX_BYTES}
          listHref={LISTS[kind] ?? null}
          stock={about.stock ? { warehouses: warehouses.map((warehouse) => ({ id: warehouse.id, name: warehouse.name })), date: entry?.openingDate ?? todayIso(new Date()) } : undefined}
          opening={about.opening && entry ? { loadedAt: entry.updatedAt.toISOString(), date: entry.openingDate } : undefined}
        />
      </Card>
    </div>
  );
}
