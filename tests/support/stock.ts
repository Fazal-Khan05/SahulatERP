import { randomUUID } from "node:crypto";
import type { AdminSql } from "./admin-db";

// Test support only. Puts stock into a synthetic company's warehouse, signed in as postgres,
// which is not held to the rule that only the posting functions write stock. The app has no way
// to bring stock in until purchases (Step 24) and opening stock (Step 30) are built; the tests
// of deliveries and invoices need some to sell.

/** Adds a quantity of an item to a warehouse at a total value, as one move in, and returns what the warehouse then holds. */
export async function seedStock(
  sql: AdminSql,
  stock: { tenantId: string; itemId: string; warehouseId: string; quantity: string; value: string; userId: string; date?: string },
): Promise<{ quantity: string; value: string }> {
  const [after] = await sql<{ quantity: string; value: string }[]>`
    with held as (
      insert into public.stock_balances (tenant_id, item_id, warehouse_id, quantity, value)
        values (${stock.tenantId}, ${stock.itemId}, ${stock.warehouseId}, ${stock.quantity}, ${stock.value})
        on conflict (tenant_id, item_id, warehouse_id)
        do update set quantity = public.stock_balances.quantity + excluded.quantity, value = public.stock_balances.value + excluded.value, updated_at = now()
        returning quantity, value
    )
    insert into public.stock_moves (tenant_id, item_id, warehouse_id, move_date, quantity, value, source_type, source_id, quantity_after, value_after, created_by)
      select ${stock.tenantId}, ${stock.itemId}, ${stock.warehouseId}, ${stock.date ?? "2026-07-01"}, ${stock.quantity}, ${stock.value}, 'test_stock', ${randomUUID()}, held.quantity, held.value, ${stock.userId}
      from held
      returning quantity_after::text as quantity, value_after::text as value`;
  return after;
}
