"use client";

import Link from "next/link";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FileForMapping, ImportProblem, PreviewOutcome } from "@/modules/data-import/commands";
import type { DataImportKind } from "@/modules/data-import/rules";
import { previewImportAction, readImportFileAction, runImportAction } from "../actions";

type Column = { key: string; header: string; required: boolean };

const SELECT = "h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm";

type Props = {
  kind: DataImportKind;
  one: string;
  many: string;
  columns: Column[];
  maxBytes: number;
  /** Where the imported rows can be seen, when there is a list of them. */
  listHref: string | null;
  /** Opening stock: the warehouses, and the day to date it on. */
  stock?: { warehouses: { id: string; name: string }[]; date: string };
  /** Opening balances: when the opening entry this page shows was loaded, and its date. */
  opening?: { loadedAt: string; date: string };
};

const letter = (index: number) => {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/**
 * Brings one file in: chosen, its columns matched to ours, checked row by row without keeping
 * anything, then imported, all of it or none. Changing anything after a check asks for a new one,
 * so what is imported is always what was checked.
 */
export function ImportScreen({ kind, one, many, columns, maxBytes, listHref, stock, opening }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, start] = useTransition();
  const [file, setFile] = useState<FileForMapping | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [headingRow, setHeadingRow] = useState("");
  const [preview, setPreview] = useState<PreviewOutcome | null>(null);
  const [problems, setProblems] = useState<ImportProblem[] | null>(null);
  const [done, setDone] = useState<{ imported: number; location: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stale = () => {
    setPreview(null);
    setProblems(null);
    setError(null);
  };
  const data = () => new FormData(form.current ?? undefined);

  const read = (withHeadingRow: boolean) => {
    const sent = data();
    if (!withHeadingRow) sent.set("headingRow", "");
    const chosen = sent.get("file");
    if (chosen instanceof File && chosen.size > maxBytes) {
      setError("The file is too large. Import at most 2,000 rows at a time.");
      return;
    }
    start(async () => {
      const result = await readImportFileAction(kind, sent);
      setPreview(null);
      setProblems(null);
      setDone(null);
      setError(result.error ?? null);
      if (result.file) {
        setFile(result.file);
        setHeadingRow(String(result.file.headingRow));
        setMapping(Object.fromEntries(columns.map((column) => [column.key, result.file!.mapping[column.key] === null ? "" : String(result.file!.mapping[column.key])])));
      } else if (!withHeadingRow) {
        setFile(null);
      }
    });
  };

  const check = () =>
    start(async () => {
      const result = await previewImportAction(kind, data());
      setProblems(null);
      setDone(null);
      setError(result.error ?? null);
      setPreview(result.preview ?? null);
    });

  const importAll = () =>
    start(async () => {
      const result = await runImportAction(kind, data());
      setError(result.error ?? null);
      if (result.problems) {
        setPreview(null);
        setProblems(result.problems);
      } else if (result.imported !== undefined) {
        setPreview(null);
        setDone({ imported: result.imported, location: result.location ?? null });
      }
    });

  const shownProblems = problems ?? (preview?.status === "problems" ? preview.problems : null);
  const fileColumnHasWarehouse = stock !== undefined && (mapping.warehouse ?? "") !== "";
  const count = (n: number, word: { one: string; many: string }) => `${n.toLocaleString("en")} ${n === 1 ? word.one : word.many}`;

  return (
    <form
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        check();
      }}
      className="flex flex-col gap-6"
    >
      {opening ? <input type="hidden" name="loadedAt" value={opening.loadedAt} /> : null}

      <section className="flex flex-col gap-1.5">
        <Label htmlFor="file">File to import</Label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className="text-sm"
          onChange={() => {
            setFile(null);
            setDone(null);
            stale();
            read(false);
          }}
        />
        <p className="text-sm text-muted-foreground">An Excel workbook (.xlsx) or a CSV file, saved from your old system. Its first sheet that has anything in it is read.</p>
      </section>

      {file ? (
        <>
          <section className="flex flex-col gap-3" aria-label="The file">
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="headingRow">The headings are in row</Label>
                <Input
                  id="headingRow"
                  name="headingRow"
                  inputMode="numeric"
                  value={headingRow}
                  onChange={(event) => {
                    setHeadingRow(event.target.value);
                    stale();
                  }}
                  className="w-24"
                />
              </div>
              <Button type="button" variant="outline" disabled={busy} onClick={() => read(true)}>
                Read the headings again
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table aria-label="The file as it is" className="w-full text-left text-xs">
                <thead className="border-b bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Row</th>
                    {file.headings.map((heading, index) => (
                      <th key={index} className="px-2 py-1.5 font-medium whitespace-nowrap">
                        {letter(index)}: {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {file.sample.map((row) => (
                    <tr key={row.row}>
                      <td className="px-2 py-1 text-muted-foreground">{row.row}</td>
                      {row.cells.map((cell, index) => (
                        <td key={index} className="px-2 py-1 whitespace-nowrap">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="flex flex-col gap-3" aria-label="Match the columns">
            <div>
              <h2 className="text-base font-semibold">Match the columns</h2>
              <p className="text-sm text-muted-foreground">
                For each of ours, choose the column of your file that holds it, or leave it out.{" "}
                {file.remembered ? "These are matched as the last file of this kind was; check them." : "The first guess comes from the file's headings; check it."}
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {columns.map((column) => (
                <div key={column.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={`map_${column.key}`}>
                    {column.header}
                    {column.required ? <span className="text-muted-foreground"> (needed)</span> : null}
                  </Label>
                  <select
                    id={`map_${column.key}`}
                    name={`map_${column.key}`}
                    value={mapping[column.key] ?? ""}
                    onChange={(event) => {
                      setMapping({ ...mapping, [column.key]: event.target.value });
                      stale();
                    }}
                    className={SELECT}
                  >
                    <option value="">{column.required ? "Choose a column" : "Not in this file"}</option>
                    {file.headings.map((heading, index) => (
                      <option key={index} value={String(index)}>
                        {letter(index)}: {heading}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex max-w-md flex-col gap-1.5">
              <Label htmlFor="leftOut">Rows to leave out</Label>
              <Input id="leftOut" name="leftOut" placeholder="For example 7, 120-125" onChange={stale} />
              <p className="text-xs text-muted-foreground">A total at the bottom, or a line your old system adds, by its row number.</p>
            </div>
          </section>

          {stock ? (
            <section className="grid max-w-2xl gap-3 sm:grid-cols-2" aria-label="Opening stock">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="date">Counted on</Label>
                <Input id="date" name="date" type="date" defaultValue={stock.date} required onChange={stale} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="warehouseId">Warehouse</Label>
                <select
                  id="warehouseId"
                  name="warehouseId"
                  key={fileColumnHasWarehouse ? "by-file" : "chosen"}
                  defaultValue=""
                  disabled={fileColumnHasWarehouse}
                  onChange={stale}
                  className={`${SELECT} disabled:opacity-60`}
                >
                  <option value="">{fileColumnHasWarehouse ? "As each row's Warehouse column says" : "Choose a warehouse"}</option>
                  {stock.warehouses.map((warehouse) => (
                    <option key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Label htmlFor="note">Note</Label>
                <Input id="note" name="note" maxLength={200} placeholder="Optional" onChange={stale} />
              </div>
            </section>
          ) : null}

          <div>
            <Button type="submit" variant={preview?.status === "ready" ? "outline" : "default"} disabled={busy}>
              {busy ? "Working…" : "Check the file"}
            </Button>
          </div>
        </>
      ) : null}

      {error ? (
        <p role="alert" data-testid="form-error" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {preview?.before ? (
        <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          This very file was imported as {many} on {preview.before.on} ({count(preview.before.rows, { one: "row", many: "rows" })}). Nothing in it is imported twice: rows already in are refused below.
        </p>
      ) : null}

      {preview && preview.sample.length > 0 ? (
        <section aria-label="Read as ours" className="flex flex-col gap-2">
          <h2 className="text-base font-semibold">The first rows, read as ours</h2>
          <div className="overflow-x-auto rounded-md border">
            <table aria-label="The file read as ours" className="w-full text-left text-xs">
              <thead className="border-b bg-muted/50 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Row</th>
                  {preview.columns.map((column) => (
                    <th key={column} className="px-2 py-1.5 font-medium whitespace-nowrap">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {preview.sample.map((row) => (
                  <tr key={row.row}>
                    <td className="px-2 py-1 text-muted-foreground">{row.row}</td>
                    {row.cells.map((cell, index) => (
                      <td key={index} className="px-2 py-1 whitespace-nowrap">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {preview?.status === "ready" ? (
        <section aria-label="Ready to import" className="flex flex-col gap-3">
          <p role="status" data-testid="import-ready" className="text-sm font-semibold">
            Every row is right: {count(preview.count, { one, many })} can be imported. Nothing has been kept yet.
          </p>
          <Button type="button" disabled={busy} onClick={importAll} className="self-start">
            {busy ? "Working…" : `Import ${count(preview.count, { one, many })}`}
          </Button>
        </section>
      ) : null}

      {shownProblems ? (
        <section data-testid="import-problems" aria-label="Rows to correct">
          <p role="alert" className="mb-2 text-sm font-semibold text-destructive">
            Nothing {problems ? "was" : "can be"} imported yet. {shownProblems.length === 1 ? "1 row needs" : `${shownProblems.length.toLocaleString("en")} rows need`} correcting: put{" "}
            {shownProblems.length === 1 ? "it" : "them"} right in the file, or leave {shownProblems.length === 1 ? "it" : "them"} out, and check again.
          </p>
          <div className="overflow-x-auto">
            <table aria-label="Rows to correct" className="w-full text-left text-sm">
              <thead className="border-b text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">Row</th>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 font-medium">What is wrong</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {shownProblems.map((problem) => (
                  <tr key={problem.row}>
                    <td className="py-2 pr-4 align-top whitespace-nowrap">{problem.row}</td>
                    <td className="py-2 pr-4 align-top">{problem.name || "(no name)"}</td>
                    <td className="py-2 align-top">{problem.problems.join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {done ? (
        <section role="status" data-testid="import-done" className="flex flex-col gap-2 rounded-md border p-4 text-sm">
          <p className="font-semibold">Imported {count(done.imported, { one, many })}.</p>
          {done.location ? (
            <p>
              The stock came in as {done.location.endsWith("/adjustments") ? "drafts, one for each warehouse" : "a draft"}: look {done.location.endsWith("/adjustments") ? "them" : "it"} over and post{" "}
              {done.location.endsWith("/adjustments") ? "them" : "it"}.{" "}
              <Link href={done.location} className="underline">
                Open {done.location.endsWith("/adjustments") ? "the drafts" : "the draft"}
              </Link>
            </p>
          ) : null}
          {opening ? (
            <p>
              They are on the draft opening entry.{" "}
              <Link href="/settings/opening-balances" className="underline">
                Look them over under Opening balances
              </Link>
            </p>
          ) : null}
          {listHref ? (
            <p>
              <Link href={listHref} className="underline">
                See the {many}
              </Link>
            </p>
          ) : null}
          <p>
            <Link href="/settings/import" className="underline">
              Back to Import data
            </Link>
          </p>
        </section>
      ) : null}
    </form>
  );
}
