import type { Tx } from "@/db";

// What a command that imports a file may be asked beside the file (Step 49, Settings, Import
// data). The commands that import customers, suppliers, items, opening stock and opening
// balances take these, so the import screen goes through the very code their own screens use.

export type ImportOptions = {
  /**
   * Do everything and keep nothing: the import runs in its transaction exactly as it would, with
   * every check the database makes, and the transaction is rolled back at its end. What it says
   * about each row is therefore what the real import will say.
   */
  preview?: boolean;
  /** Runs inside the import's transaction once every row is in, with how many went in. */
  record?: (tx: Tx, imported: number) => Promise<void>;
};

/** Thrown at the end of a preview to roll its transaction back; carries how many rows would have gone in. */
export class PreviewRolledBack extends Error {
  constructor(readonly imported: number) {
    super("An import previewed and rolled back on purpose.");
    this.name = "PreviewRolledBack";
  }
}

/**
 * An import's last act inside its transaction, with how many rows it put in: a preview is rolled
 * back here; a real import is recorded.
 */
export async function finishImport(tx: Tx, options: ImportOptions | undefined, imported: number): Promise<void> {
  if (options?.preview) throw new PreviewRolledBack(imported);
  if (options?.record) await options.record(tx, imported);
}
