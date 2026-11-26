"use server";

import { refresh } from "next/cache";
import { requireTenant } from "@/lib/auth/session";
import { UserError, logFailure } from "@/lib/errors";
import { previewImport, readFileForMapping, runImport, type FileForMapping, type ImportAsk, type ImportProblem, type PreviewOutcome } from "@/modules/data-import/commands";
import { IMPORT_FILE_MAX_BYTES } from "@/modules/data-import/file";
import { IMPORT_KINDS, isDataImportKind, type DataImportKind } from "@/modules/data-import/rules";
import { MODULE_INFO } from "@/modules/tenant/rules";

// Step 49, Settings, Import data. The company always comes from the verified session, never from
// the form; the kind is bound to the action and checked again, and the command that imports each
// kind checks who may import it.

type Gate = { session: Awaited<ReturnType<typeof requireTenant>>; kind: DataImportKind; file: File } | { error: string };

async function open(kind: unknown, formData: FormData): Promise<Gate> {
  const session = await requireTenant();
  if (!isDataImportKind(kind)) return { error: "That did not work. Please try again." };
  const needs = IMPORT_KINDS[kind].module;
  if (needs && !session.modules[needs]) return { error: `${MODULE_INFO[needs].label} is switched off for this company.` };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose the file to import: an Excel workbook or a CSV file." };
  if (file.size > IMPORT_FILE_MAX_BYTES) return { error: "The file is too large. Import at most 2,000 rows at a time." };
  return { session, kind, file };
}

function refusal(context: string, error: unknown): { error: string } {
  if (error instanceof UserError) return { error: error.message };
  logFailure(context, error);
  return { error: "That did not work. Please try again." };
}

async function askOf(kind: DataImportKind, file: File, formData: FormData): Promise<ImportAsk> {
  return {
    kind,
    file: { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
    headingRow: formData.get("headingRow"),
    field: (name) => formData.get(name),
    date: formData.get("date"),
    warehouseId: formData.get("warehouseId"),
    note: formData.get("note"),
    loadedAt: formData.get("loadedAt"),
  };
}

export type ReadResult = { error?: string; file?: FileForMapping };

/** Reads a file far enough to match its columns to ours. */
export async function readImportFileAction(kind: DataImportKind, formData: FormData): Promise<ReadResult> {
  const gate = await open(kind, formData);
  if ("error" in gate) return gate;
  try {
    return { file: await readFileForMapping(gate.session, gate.kind, { name: gate.file.name, bytes: new Uint8Array(await gate.file.arrayBuffer()) }, formData.get("headingRow")) };
  } catch (error) {
    return refusal("read import file", error);
  }
}

export type PreviewResult = { error?: string; preview?: PreviewOutcome };

/** Checks every row of the file as the import will, and keeps nothing. */
export async function previewImportAction(kind: DataImportKind, formData: FormData): Promise<PreviewResult> {
  const gate = await open(kind, formData);
  if ("error" in gate) return gate;
  try {
    return { preview: await previewImport(gate.session, await askOf(gate.kind, gate.file, formData)) };
  } catch (error) {
    return refusal("check import file", error);
  }
}

export type RunResult = { error?: string; imported?: number; location?: string | null; problems?: ImportProblem[] };

/** Imports the file, all of it or none. */
export async function runImportAction(kind: DataImportKind, formData: FormData): Promise<RunResult> {
  const gate = await open(kind, formData);
  if ("error" in gate) return gate;
  let result: RunResult;
  try {
    const outcome = await runImport(gate.session, await askOf(gate.kind, gate.file, formData));
    result = outcome.status === "imported" ? { imported: outcome.imported, location: outcome.location } : { problems: outcome.problems };
  } catch (error) {
    return refusal("import file", error);
  }
  refresh();
  return result;
}
