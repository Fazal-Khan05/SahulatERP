import "server-only";
import Decimal from "decimal.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isUuid, type Tx } from "@/db";
import { stockBalances, stockMoves } from "./schema";

// Stock as the database holds it: what each warehouse has of each item, and what it is worth.
// Row-level security decides what the reader may see: the stock of the warehouses of their own
// branches, for the roles that work with stock.

/**
 * How much a warehouse holds of some items, in each item's own unit, inside a transaction the
 * caller holds. An item it has never held is absent. What the stock is worth is not read here:
 * the app's role cannot read it.
 */
export async function selectStockOnHand(tx: Tx, tenantId: string, warehouseId: string, itemIds: readonly string[]): Promise<Map<string, Decimal>> {
  const ids = [...new Set(itemIds)].filter(isUuid);
  if (ids.length === 0 || !isUuid(warehouseId)) return new Map();
  const rows = await tx
    .select({ itemId: stockBalances.itemId, quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(and(eq(stockBalances.tenantId, tenantId), eq(stockBalances.warehouseId, warehouseId), inArray(stockBalances.itemId, ids)));
  return new Map(rows.map((row) => [row.itemId, new Decimal(row.quantity)]));
}

/**
 * What the goods of one document cost when they left stock, line by line: the value of its
 * moves out. The moves that undid them, if the document was cancelled, are left out.
 */
export async function selectMoveCosts(tx: Tx, tenantId: string, sourceType: string, sourceId: string): Promise<Map<string, Decimal>> {
  const rows = await tx
    .select({ lineId: stockMoves.sourceLineId, cost: sql<string>`(-${stockMoves.value})::text` })
    .from(stockMoves)
    .where(and(eq(stockMoves.tenantId, tenantId), eq(stockMoves.sourceType, sourceType), eq(stockMoves.sourceId, sourceId), isNull(stockMoves.reversesMoveId)));
  return new Map(rows.filter((row): row is { lineId: string; cost: string } => row.lineId !== null).map((row) => [row.lineId, new Decimal(row.cost)]));
}
