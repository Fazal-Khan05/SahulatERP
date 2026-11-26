import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/db";
import { UserError } from "@/lib/errors";
import { PreviewRolledBack, type ImportOptions } from "@/lib/import-options";
import { todayIso } from "@/lib/format";
import { formatIsoDate } from "@/modules/currencies/rules";
import { importOpeningStock } from "@/modules/inventory/commands";
import { importItems } from "@/modules/items/commands";
import { importOpeningLines } from "@/modules/opening/commands";
import { importParties } from "@/modules/parties/commands";
import { can, type TenantContext } from "@/modules/tenant/rules";
import { cleanFileName, fileSha256, readImportFile } from "./file";
import {
  IMPORT_KINDS,
  findHeadingRow,
  headingsOf,
  mappedCsv,
  mappingByHeading,
  readLeftOut,
  readMapping,
  sampleRows,
  suggestMapping,
  type ColumnMapping,
  type DataImportKind,
} from "./rules";
import { dataImports } from "./schema";

// Step 49, Settings, Import data: a file from another system, read by the mapping its importer
// chose, checked, and imported all or nothing through the command that imports that kind from
// its own screen. Nothing here writes a customer, an item, stock or a balance itself.

export type ImportProblem = { row: number; name: string; problems: string[] };
export type ImportFile = { name: string; bytes: Uint8Array };

/** What the import screen sends besides the file: everything comes from the form, unchecked. */
export type ImportAsk = {
  kind: DataImportKind;
  file: ImportFile;
  /** The row the headings are in, 1 for the first; empty for the row this module finds. */
  headingRow?: unknown;
  /** The form's fields: `map_<our key>` is the index of the file's column for it, or empty. */
  field: (name: string) => unknown;
  /** Opening stock: the day it was counted, the warehouse (unless the file names them) and a note. */
  date?: unknown;
  warehouseId?: unknown;
  note?: unknown;
  /** The opening balances: when the page showing the opening entry was loaded. */
  loadedAt?: unknown;
};

/** How many rows under the headings the screen shows while the columns are matched. */
const SAMPLE_ROWS = 8;

function requireImporter(ctx: TenantContext, kind: DataImportKind): void {
  if (!can(ctx.role, "opening.manage")) throw new UserError("Only an owner or an accountant can import a company's data.");
  if (!can(ctx.role, IMPORT_KINDS[kind].permission)) throw new UserError(`Your role cannot import ${IMPORT_KINDS[kind].many}.`);
}

async function rowsOf(file: ImportFile): Promise<string[][]> {
  const read = await readImportFile(file.bytes);
  if (!read.ok) throw new UserError(read.reason);
  return read.rows;
}

function headingAtOf(rows: readonly (readonly string[])[], raw: unknown): number {
  const typed = typeof raw === "string" ? raw.trim() : "";
  if (typed === "") return findHeadingRow(rows);
  const row = Number(typed);
  if (!Number.isInteger(row) || row < 1 || row > Math.min(rows.length, 50)) throw new UserError(`The headings must be in one of the first ${Math.min(rows.length, 50)} rows.`);
  return row - 1;
}

/** The mapping the last file of this kind was imported with, by heading, or null. */
async function rememberedMapping(ctx: TenantContext, kind: DataImportKind): Promise<Record<string, string> | null> {
  const [last] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ mapping: dataImports.mapping })
      .from(dataImports)
      .where(and(eq(dataImports.tenantId, ctx.tenantId), eq(dataImports.kind, kind)))
      .orderBy(desc(dataImports.createdAt))
      .limit(1),
  );
  const mapping = last?.mapping;
  return mapping && typeof mapping === "object" && !Array.isArray(mapping) ? (mapping as Record<string, string>) : null;
}

export type FileForMapping = {
  headingRow: number;
  headings: string[];
  /** Rows under the headings, as the file has them, for choosing the columns by eye. */
  sample: { row: number; cells: string[] }[];
  /** A first guess, from the last file of this kind or from the headings. */
  mapping: ColumnMapping;
  remembered: boolean;
};

/** Reads a file far enough to match its columns: where its headings are, what they are, and a guess. */
export async function readFileForMapping(ctx: TenantContext, kind: DataImportKind, file: ImportFile, headingRow?: unknown): Promise<FileForMapping> {
  requireImporter(ctx, kind);
  const rows = await rowsOf(file);
  const headingAt = headingAtOf(rows, headingRow);
  const headings = headingsOf(rows[headingAt] ?? []);
  if (headings.length === 0) throw new UserError("The file has nothing in it to import.");
  const remembered = await rememberedMapping(ctx, kind);
  const mapping = suggestMapping(IMPORT_KINDS[kind], headings, remembered);
  const sample: { row: number; cells: string[] }[] = [];
  for (let index = headingAt + 1; index < rows.length && sample.length < SAMPLE_ROWS; index++) {
    const cells = headings.map((_, column) => (rows[index][column] ?? "").trim().slice(0, 80));
    if (cells.some((cell) => cell !== "")) sample.push({ row: index + 1, cells });
  }
  return { headingRow: headingAt + 1, headings, sample, mapping, remembered: remembered !== null && Object.values(mapping).some((index) => index !== null) };
}

type Prepared = { csv: string; headings: string[]; mapping: ColumnMapping; sample: { row: number; cells: string[] }[]; name: string; sha256: string };

async function prepare(ctx: TenantContext, ask: ImportAsk): Promise<Prepared> {
  requireImporter(ctx, ask.kind);
  const kind = IMPORT_KINDS[ask.kind];
  const rows = await rowsOf(ask.file);
  const headingAt = headingAtOf(rows, ask.headingRow);
  const headings = headingsOf(rows[headingAt] ?? []);
  const mapping = readMapping(kind, ask.field, headings);
  if (!mapping.ok) throw new UserError(mapping.reason);
  const leftOut = readLeftOut(ask.field("leftOut"));
  if (!leftOut.ok) throw new UserError(leftOut.reason);
  return {
    csv: mappedCsv(kind, rows, headingAt, mapping.mapping, leftOut.rows),
    headings,
    mapping: mapping.mapping,
    sample: sampleRows(kind, rows, headingAt, mapping.mapping, leftOut.rows, SAMPLE_ROWS),
    name: cleanFileName(ask.file.name),
    sha256: fileSha256(ask.file.bytes),
  };
}

type Dispatched = { imported: number; location?: string } | { problems: ImportProblem[] };

/** Hands the file, in our layout, to the command that imports this kind. */
async function dispatch(ctx: TenantContext, ask: ImportAsk, prepared: Prepared, options: ImportOptions): Promise<Dispatched> {
  const file = { name: prepared.name, text: prepared.csv };
  switch (ask.kind) {
    case "customers":
      return importParties(ctx, "customer", file, options);
    case "suppliers":
      return importParties(ctx, "supplier", file, options);
    case "items":
      return importItems(ctx, file, options);
    case "opening_stock": {
      const result = await importOpeningStock(ctx, { date: ask.date, warehouseId: ask.warehouseId, note: ask.note, csv: prepared.csv }, options);
      if (result.ok) return { imported: result.lines, location: result.ids.length === 1 ? `/stock/adjustments/${result.ids[0]}` : "/stock/adjustments" };
      if (result.problems) return { problems: result.problems };
      throw new UserError(result.reason ?? "The file could not be read.");
    }
    case "customer_balances":
      return importOpeningLines(ctx, "receivable", file, ask.loadedAt, options);
    case "supplier_balances":
      return importOpeningLines(ctx, "payable", file, ask.loadedAt, options);
    case "ledger_balances":
      return importOpeningLines(ctx, "account", file, ask.loadedAt, options);
  }
}

export type PreviewOutcome = {
  columns: string[];
  sample: { row: number; cells: string[] }[];
  /** The same file imported as this kind before: when, and how many rows. */
  before: { on: string; rows: number } | null;
} & ({ status: "ready"; count: number } | { status: "problems"; problems: ImportProblem[] });

/**
 * Checks a file without keeping anything: the import runs as it would, every check made, and is
 * rolled back. What it says about each row is what the import will say.
 */
export async function previewImport(ctx: TenantContext, ask: ImportAsk): Promise<PreviewOutcome> {
  const prepared = await prepare(ctx, ask);
  const kind = IMPORT_KINDS[ask.kind];
  const columns = kind.columns.filter((column) => typeof prepared.mapping[column.key] === "number").map((column) => column.header);
  const [earlier] = await withTenant(ctx.userId, ctx.tenantId, (tx) =>
    tx
      .select({ createdAt: dataImports.createdAt, rows: dataImports.rows })
      .from(dataImports)
      .where(and(eq(dataImports.tenantId, ctx.tenantId), eq(dataImports.kind, ask.kind), eq(dataImports.fileSha256, prepared.sha256)))
      .orderBy(desc(dataImports.createdAt))
      .limit(1),
  );
  const before = earlier ? { on: formatIsoDate(todayIso(earlier.createdAt)), rows: earlier.rows } : null;
  const base = { columns, sample: prepared.sample, before };
  try {
    const outcome = await dispatch(ctx, ask, prepared, { preview: true });
    if ("problems" in outcome) return { ...base, status: "problems", problems: outcome.problems };
    // Every import ends a preview by rolling back; this is never reached, but would mean nothing was kept.
    return { ...base, status: "ready", count: outcome.imported };
  } catch (error) {
    if (error instanceof PreviewRolledBack) return { ...base, status: "ready", count: error.imported };
    throw error;
  }
}

export type ImportOutcome = { status: "imported"; imported: number; location: string | null } | { status: "problems"; problems: ImportProblem[] };

/** Imports a file, all of it or none, and records the import with the mapping it was read by. */
export async function runImport(ctx: TenantContext, ask: ImportAsk): Promise<ImportOutcome> {
  const prepared = await prepare(ctx, ask);
  const outcome = await dispatch(ctx, ask, prepared, {
    // Only the columns the app may write are named: the id and the time are the database's.
    record: async (tx, imported) => {
      await tx.execute(sql`
        insert into public.data_imports (tenant_id, kind, file_name, file_sha256, rows, mapping, created_by)
        values (${ctx.tenantId}::uuid, ${ask.kind}, ${prepared.name}, ${prepared.sha256}, ${imported}, ${JSON.stringify(mappingByHeading(prepared.mapping, prepared.headings))}::jsonb, ${ctx.userId}::uuid)`);
    },
  });
  if ("problems" in outcome) return { status: "problems", problems: outcome.problems };
  return { status: "imported", imported: outcome.imported, location: outcome.location ?? null };
}
