import type { Module, ToggleModule, Workspace } from "./types";

/**
 * The module catalogue. One definition drives the onboarding wizard, Settings → Features,
 * the sidebar, header actions, search, notifications and server-side command gating.
 */
export type ModuleDefinition = {
  key: ToggleModule;
  label: string;
  description: string;
  /** Plain-language note shown on the card: what enabling it sets up. */
  setsUp: string;
  requires: ToggleModule[];
  /** Engine command types this module owns; rejected while the module is off. */
  commands: string[];
};

export const moduleCatalogue: ModuleDefinition[] = [
  { key: "sales", label: "Sales", description: "Quotations, orders, deliveries, invoices and returns for your customers.", setsUp: "Customer list, sales number series (QUO, SO, DN, INV, CN) and receivable, revenue and output-tax accounts.", requires: [], commands: [] },
  { key: "purchasing", label: "Purchasing", description: "Supplier orders, goods receipts, bills and supplier returns.", setsUp: "Supplier list, purchase number series (PO, GRN, BILL, PR) and payable and input-tax accounts.", requires: [], commands: [] },
  { key: "inventory", label: "Inventory", description: "Stock by warehouse, transfers, counts and weighted-average valuation.", setsUp: "A first branch and warehouse if you have none, and inventory and cost-of-sales accounts.", requires: [], commands: ["stock_transfer", "stock_adjust", "set_stock_quantity", "bulk_stock_increase", "save_item"] },
  { key: "imports", label: "Imports & costing", description: "Shipments, customs and freight charges allocated into landed cost.", setsUp: "Shipment number series and the deposits and operating-expense accounts used for import charges.", requires: ["purchasing", "inventory"], commands: ["create_shipment", "add_shipment_cost", "allocate_shipment"] },
  { key: "collections", label: "Collections & PDCs", description: "Customer receipts, post-dated cheques and recovery follow-ups.", setsUp: "Receipt number series and the bank & cash account.", requires: ["sales"], commands: ["update_cheque", "follow_up"] },
  { key: "commissions", label: "Commissions", description: "Salesperson entitlements that release as customers actually pay.", setsUp: "A draft commission plan to edit, and the commission expense and payable accounts.", requires: ["sales", "collections"], commands: ["save_plan", "approve_commission"] },
  { key: "payroll", label: "Payroll", description: "Monthly salary runs with attendance, deductions and commission settlement.", setsUp: "Salary, payroll-payable and statutory accounts. You enter your own EOBI and tax rates before the first run.", requires: [], commands: ["create_payroll", "update_payroll"] },
  { key: "reports", label: "Reports", description: "Sales, stock, receivables and ledger reports with reconciliation checks.", setsUp: "Nothing extra; reports read your existing records.", requires: [], commands: [] },
];

export const toggleModules = moduleCatalogue.map(item => item.key);

export const presets: { key: string; label: string; description: string; modules: ToggleModule[] }[] = [
  { key: "distributor", label: "Importer-distributor", description: "Everything an importing wholesaler needs, including commissions.", modules: ["sales", "purchasing", "inventory", "imports", "collections", "commissions", "reports"] },
  { key: "basics", label: "Just the basics", description: "Buy, stock, sell and see reports. Add the rest later.", modules: ["sales", "purchasing", "inventory", "reports"] },
];

const byKey = new Map(moduleCatalogue.map(item => [item.key, item]));
export const isToggleModule = (value: string): value is ToggleModule => byKey.has(value as ToggleModule);

/** Adds every module the selection depends on, transitively. */
export function withRequirements(selected: Iterable<ToggleModule>): ToggleModule[] {
  const result = new Set<ToggleModule>();
  const visit = (key: ToggleModule) => { if (result.has(key)) return; result.add(key); for (const dep of byKey.get(key)!.requires) visit(dep); };
  for (const key of selected) visit(key);
  return toggleModules.filter(key => result.has(key));
}

/** Modules that must also be turned off when `key` is turned off. */
export function dependentsOf(key: ToggleModule, enabled: Iterable<ToggleModule>): ToggleModule[] {
  const on = new Set(enabled);
  const result = new Set<ToggleModule>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of moduleCatalogue) {
      if (!on.has(item.key) || result.has(item.key) || item.key === key) continue;
      if (item.requires.some(dep => dep === key || result.has(dep))) { result.add(item.key); changed = true; }
    }
  }
  return toggleModules.filter(item => result.has(item));
}

/** Document kinds, by module, used for gating create/submit/convert/return and for record counts. */
export const salesKinds = ["quotation", "sales_order", "delivery", "sales_invoice", "credit_note"] as const;
export const purchaseKinds = ["purchase_order", "goods_receipt", "supplier_invoice", "supplier_return"] as const;

/** Which toggleable module a command belongs to, or null when it is always available. */
export function moduleOfCommand(type: string, payload: Record<string, unknown>, w: Workspace): ToggleModule | null {
  for (const item of moduleCatalogue) if (item.commands.includes(type)) return item.key;
  if (["create_document", "submit_document", "convert_document", "return_document"].includes(type)) {
    const kind = type === "create_document" ? String(payload.kind ?? "") : w.documents.find(d => d.id === payload.id)?.kind ?? "";
    if ((salesKinds as readonly string[]).includes(kind)) return "sales";
    if ((purchaseKinds as readonly string[]).includes(kind)) return "purchasing";
    return null;
  }
  if (type === "create_receipt") return w.parties.find(p => p.id === payload.partyId)?.type === "supplier" ? "purchasing" : "collections";
  if (type === "save_party") return payload.type === "supplier" ? "purchasing" : "sales";
  if (type === "save_employee") return w.modules.includes("payroll") ? "payroll" : "commissions";
  if (type === "import_records") return payload.kind === "attendance" ? "payroll" : payload.kind === "items" ? "inventory" : payload.kind === "suppliers" ? "purchasing" : "sales";
  return null;
}

/** Count of records a module holds, shown when turning it off so the user knows what will be hidden (never deleted). */
export function moduleRecordCounts(w: Workspace, key: ToggleModule): { label: string; count: number }[] {
  const docs = (kinds: readonly string[]) => w.documents.filter(d => kinds.includes(d.kind)).length;
  switch (key) {
    case "sales": return [{ label: "sales documents", count: docs(salesKinds) }, { label: "customers", count: w.parties.filter(p => p.type === "customer").length }];
    case "purchasing": return [{ label: "purchase documents", count: docs(purchaseKinds) }, { label: "suppliers", count: w.parties.filter(p => p.type === "supplier").length }];
    case "inventory": return [{ label: "products", count: w.items.length }, { label: "stock movements", count: w.stockMoves.length }];
    case "imports": return [{ label: "shipments", count: w.shipments.length }];
    case "collections": return [{ label: "receipts", count: w.receipts.length }, { label: "follow-ups", count: w.followUps.length }];
    case "commissions": return [{ label: "entitlements", count: w.commissions.length }, { label: "plans", count: w.plans.length }];
    case "payroll": return [{ label: "payroll runs", count: w.payrolls.length }, { label: "employees", count: w.employees.length }];
    case "reports": return [];
  }
}

/** Navigation module → toggle module. Always-on modules return null. */
export function toggleOf(module: Module): ToggleModule | null {
  return isToggleModule(module) ? module : null;
}

export function moduleEnabled(w: Pick<Workspace, "modules">, module: Module) {
  const key = toggleOf(module);
  return key === null || w.modules.includes(key);
}
