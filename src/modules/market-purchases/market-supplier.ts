import { sql } from "drizzle-orm";
import { suppliers } from "../parties/schema";

/**
 * For a list of suppliers to choose from on an order or a bill: leaves out the market supplier,
 * who is bought from only through a quick market purchase. Kept apart from the module's queries
 * so the buying modules can use it without reading them.
 */
export const notMarketSupplier = sql`not exists (select 1 from public.market_suppliers m where m.tenant_id = ${suppliers.tenantId} and m.supplier_id = ${suppliers.id})`;
