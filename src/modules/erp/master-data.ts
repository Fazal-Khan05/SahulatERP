import type { Employee, Item, Party, Workspace } from "./types";

/**
 * One specification per master-data entity drives the list screen, the edit form, CSV import
 * headers and CSV export. Keeping it here (not in components) lets tests and the importer share it.
 */
export type FieldType = "text" | "textarea" | "number" | "money" | "percent" | "select" | "checkbox" | "pairs";
export type FieldSpec = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  hint?: string;
  options?: { value: string; label: string }[] | ((w: Workspace) => { value: string; label: string }[]);
  csv?: boolean;        // included in import/export (default true for non-pairs fields)
  full?: boolean;       // spans both columns in the form
};
export type EntitySpec<T extends { id: string } = { id: string }> = {
  key: "customers" | "suppliers" | "items" | "employees" | "warehouses" | "plans";
  label: string;
  singular: string;
  /** Engine command and the import kind; warehouses and plans have no bulk import. */
  saveCommand: string;
  importKind?: "customers" | "suppliers" | "items" | "employees";
  archiveKind?: "party" | "item";
  fields: FieldSpec[];
  columns: { key: string; label: string; render?: (record: T, w: Workspace) => string }[];
  records: (w: Workspace) => T[];
  blank: (w: Workspace) => Record<string, unknown>;
  /** Converts a record into a save payload (strips derived fields). */
  toPayload: (record: T) => Record<string, unknown>;
  isArchived?: (record: T) => boolean;
  searchText: (record: T, w: Workspace) => string;
};

const partyFields = (type: "customer" | "supplier"): FieldSpec[] => [
  { key: "name", label: `${type === "customer" ? "Customer" : "Supplier"} name`, type: "text", required: true, full: true },
  { key: "city", label: "City", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "taxId", label: "NTN / STRN", type: "text" },
  { key: "registered", label: "Sales-tax registered", type: "checkbox", hint: "Affects tax treatment on documents" },
  { key: "customerClass", label: type === "customer" ? "Customer class" : "Supplier class", type: "text", hint: type === "customer" ? "e.g. Distributor, Retailer; used by commission plans" : "e.g. Importer, Domestic" },
  { key: "creditLimit", label: "Credit limit (PKR)", type: "money", hint: "0 means no limit; a positive limit blocks invoices beyond it unless an owner overrides" },
  { key: "terms", label: "Payment terms (days)", type: "number" },
];

export const partyToPayload = (p: Party) => ({ id: p.id, name: p.name, type: p.type, city: p.city, email: p.email, phone: p.phone ?? "", taxId: p.taxId, registered: p.registered, creditLimit: p.creditLimit, terms: p.terms, customerClass: p.customerClass });

export const customers: EntitySpec<Party> = {
  key: "customers", label: "Customers", singular: "customer", saveCommand: "save_party", importKind: "customers", archiveKind: "party",
  fields: partyFields("customer"),
  columns: [{ key: "name", label: "Customer" }, { key: "city", label: "City" }, { key: "phone", label: "Phone" }, { key: "customerClass", label: "Class" }, { key: "terms", label: "Terms", render: r => `${r.terms} days` }, { key: "creditLimit", label: "Credit limit" }],
  records: w => w.parties.filter(p => p.type === "customer"),
  blank: () => ({ type: "customer", name: "", city: "", phone: "", email: "", taxId: "", registered: false, customerClass: "Retailer", creditLimit: "0", terms: 30 }),
  toPayload: partyToPayload, isArchived: r => !!r.archived, searchText: r => `${r.name} ${r.city} ${r.phone ?? ""} ${r.email} ${r.customerClass}`,
};

export const suppliers: EntitySpec<Party> = {
  ...customers, key: "suppliers", label: "Suppliers", singular: "supplier", importKind: "suppliers",
  fields: partyFields("supplier"),
  columns: [{ key: "name", label: "Supplier" }, { key: "city", label: "City" }, { key: "phone", label: "Phone" }, { key: "customerClass", label: "Class" }, { key: "terms", label: "Terms", render: r => `${r.terms} days` }],
  records: w => w.parties.filter(p => p.type === "supplier"),
  blank: () => ({ type: "supplier", name: "", city: "", phone: "", email: "", taxId: "", registered: false, customerClass: "Importer", creditLimit: "0", terms: 30 }),
};

export const items: EntitySpec<Item> = {
  key: "items", label: "Products", singular: "product", saveCommand: "save_item", importKind: "items", archiveKind: "item",
  fields: [
    { key: "sku", label: "SKU / code", type: "text", required: true },
    { key: "name", label: "Product name", type: "text", required: true },
    { key: "category", label: "Category", type: "text", hint: "Used by category-based commission plans" },
    { key: "unit", label: "Unit", type: "text", hint: "pcs, box, kg…" },
    { key: "price", label: "Selling price (PKR)", type: "money" },
    { key: "cost", label: "Standard cost (PKR)", type: "money", hint: "Used only when there is no stock history" },
    { key: "hsCode", label: "HS code", type: "text", hint: "For imports and customs" },
    { key: "reorderLevel", label: "Reorder level", type: "number" },
    { key: "weight", label: "Weight (kg)", type: "number", hint: "Landed-cost allocation by weight" },
    { key: "volume", label: "Volume (m³)", type: "number", hint: "Landed-cost allocation by volume" },
  ],
  columns: [{ key: "sku", label: "SKU" }, { key: "name", label: "Product" }, { key: "category", label: "Category" }, { key: "unit", label: "Unit" }, { key: "price", label: "Price" }, { key: "cost", label: "Cost" }, { key: "reorderLevel", label: "Reorder" }],
  records: w => w.items,
  blank: () => ({ sku: "", name: "", category: "General", unit: "pcs", price: "0", cost: "0", hsCode: "", reorderLevel: 0, weight: "1", volume: "1" }),
  toPayload: i => ({ id: i.id, sku: i.sku, name: i.name, category: i.category, hsCode: i.hsCode, unit: i.unit, price: i.price, cost: i.cost, weight: i.weight, volume: i.volume, reorderLevel: i.reorderLevel }),
  isArchived: r => !!r.archived, searchText: r => `${r.sku} ${r.name} ${r.category} ${r.hsCode}`,
};

export const employees: EntitySpec<Employee> = {
  key: "employees", label: "Employees", singular: "employee", saveCommand: "save_employee", importKind: "employees",
  fields: [
    { key: "name", label: "Full name", type: "text", required: true },
    { key: "role", label: "Role / designation", type: "text" },
    { key: "territory", label: "Territory", type: "text" },
    { key: "parentId", label: "Reports to", type: "select", options: w => [{ value: "", label: "— none —" }, ...w.employees.map(e => ({ value: e.id, label: e.name }))], csv: false },
    { key: "salary", label: "Monthly salary (PKR)", type: "money" },
    { key: "allowance", label: "Allowances (PKR)", type: "money" },
    { key: "deduction", label: "Fixed deductions (PKR)", type: "money" },
    { key: "attendance", label: "Attendance days (this month)", type: "number", hint: "Out of 30; import monthly from your attendance sheet" },
    { key: "active", label: "Active", type: "checkbox" },
  ],
  columns: [{ key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "territory", label: "Territory" }, { key: "parentId", label: "Reports to", render: (r, w) => w.employees.find(e => e.id === r.parentId)?.name ?? "—" }, { key: "salary", label: "Salary" }, { key: "attendance", label: "Attendance" }],
  records: w => w.employees,
  blank: () => ({ name: "", role: "", territory: "", parentId: "", salary: "0", allowance: "0", deduction: "0", attendance: 30, active: true }),
  toPayload: e => ({ id: e.id, name: e.name, role: e.role, territory: e.territory, ...(e.parentId ? { parentId: e.parentId } : {}), salary: e.salary, allowance: e.allowance, deduction: e.deduction, attendance: e.attendance, active: e.active }),
  isArchived: r => !r.active, searchText: r => `${r.name} ${r.role} ${r.territory}`,
};

type Warehouse = Workspace["warehouses"][number];
export const warehouses: EntitySpec<Warehouse> = {
  key: "warehouses", label: "Warehouses", singular: "warehouse", saveCommand: "save_warehouse",
  fields: [
    { key: "name", label: "Warehouse name", type: "text", required: true },
    { key: "branchId", label: "Branch", type: "select", required: true, options: w => w.branches.map(b => ({ value: b.id, label: b.name })) },
  ],
  columns: [{ key: "name", label: "Warehouse" }, { key: "branchId", label: "Branch", render: (r, w) => w.branches.find(b => b.id === r.branchId)?.name ?? r.branchId }],
  records: w => w.warehouses,
  blank: w => ({ name: "", branchId: w.branches[0]?.id ?? "" }),
  toPayload: x => ({ id: x.id, name: x.name, branchId: x.branchId }),
  searchText: (r, w) => `${r.name} ${w.branches.find(b => b.id === r.branchId)?.name ?? ""}`,
};

type Plan = Workspace["plans"][number];
export const plans: EntitySpec<Plan> = {
  key: "plans", label: "Commission plans", singular: "commission plan", saveCommand: "save_plan",
  fields: [
    { key: "name", label: "Plan name", type: "text", required: true, full: true },
    { key: "effectiveFrom", label: "Effective from", type: "text", required: true, hint: "YYYY-MM-DD" },
    { key: "effectiveTo", label: "Effective to", type: "text", required: true, hint: "YYYY-MM-DD; plans may not overlap" },
    { key: "type", label: "Plan type", type: "select", required: true, options: [{ value: "flat", label: "Flat % of net sale" }, { value: "category", label: "% by product category" }, { value: "customer_class", label: "% by customer class" }, { value: "per_unit", label: "Fixed amount per unit" }, { value: "tiered", label: "Tiered % by invoice value" }] },
    { key: "rate", label: "Default rate", type: "percent", hint: "% of net, or PKR per unit for per-unit plans" },
    { key: "categoryRates", label: "Category rates", type: "pairs", hint: "One per line: Category = %", full: true },
    { key: "classRates", label: "Customer-class rates", type: "pairs", hint: "One per line: Class = %", full: true },
    { key: "tiers", label: "Tiers", type: "pairs", hint: "One per line: from amount = %", full: true },
    { key: "target", label: "Monthly target (PKR)", type: "money", hint: "0 = no target" },
    { key: "multiplier", label: "Multiplier above target", type: "number", hint: "1 = no change" },
  ],
  columns: [{ key: "name", label: "Plan" }, { key: "type", label: "Type", render: r => r.type.replaceAll("_", " ") }, { key: "rate", label: "Rate" }, { key: "effectiveFrom", label: "From" }, { key: "effectiveTo", label: "To" }],
  records: w => w.plans,
  blank: () => ({ name: "", effectiveFrom: `${new Date().getFullYear()}-01-01`, effectiveTo: "2099-12-31", type: "flat", rate: "0", categoryRates: {}, classRates: {}, tiers: [{ threshold: "0", rate: "0" }], target: "0", multiplier: "1" }),
  toPayload: p => ({ id: p.id, name: p.name, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, type: p.type, rate: p.rate, categoryRates: p.categoryRates, classRates: p.classRates, tiers: p.tiers, target: p.target, multiplier: p.multiplier }),
  searchText: r => `${r.name} ${r.type}`,
};

export const entitySpecs = { customers, suppliers, items, employees, warehouses, plans } as const;

/** CSV header synonyms → field keys, so files from FastAccounts, Excel or Tally map without manual work. */
const synonyms: Record<string, string> = {
  "customer name": "name", "supplier name": "name", "party name": "name", "company": "name", "product name": "name", "item name": "name", "description": "name", "employee name": "name", "full name": "name",
  "code": "sku", "item code": "sku", "product code": "sku", "part number": "sku",
  "mobile": "phone", "telephone": "phone", "contact": "phone",
  "ntn": "taxId", "strn": "taxId", "tax id": "taxId", "tax number": "taxId", "gst": "taxId",
  "class": "customerClass", "customer class": "customerClass", "type": "customerClass", "group": "customerClass",
  "credit limit": "creditLimit", "limit": "creditLimit", "terms": "terms", "payment terms": "terms", "credit days": "terms", "days": "terms",
  "selling price": "price", "sale price": "price", "rate": "price", "unit price": "price", "purchase price": "cost", "cost price": "cost",
  "uom": "unit", "unit of measure": "unit", "hs code": "hsCode", "hscode": "hsCode", "reorder": "reorderLevel", "reorder level": "reorderLevel", "min stock": "reorderLevel",
  "designation": "role", "basic": "salary", "basic salary": "salary", "monthly salary": "salary", "allowances": "allowance", "deductions": "deduction", "reports to": "manager", "manager": "manager", "area": "territory", "region": "territory",
  "registered": "registered", "sales tax registered": "registered", "active": "active", "attendance days": "attendance", "present days": "attendance",
};

export function mapHeader(header: string, fields: FieldSpec[]): string | null {
  const cleaned = header.trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
  const direct = fields.find(f => f.key.toLowerCase() === cleaned.replace(/ /g, "") || f.label.toLowerCase() === cleaned);
  if (direct) return direct.key;
  const mapped = synonyms[cleaned];
  if (mapped === "manager") return "manager";
  if (mapped && fields.some(f => f.key === mapped)) return mapped;
  return null;
}

export function csvFields(spec: EntitySpec<never>): FieldSpec[] {
  const base = (spec.fields as FieldSpec[]).filter(f => f.csv !== false && f.type !== "pairs");
  return spec.key === "employees" ? [...base, { key: "manager", label: "Reports to (name)", type: "text" }] : base;
}

export function toCsv(rows: Record<string, unknown>[], headers: string[]) {
  const escape = (value: unknown) => { const text = value === undefined || value === null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };
  return [headers.join(","), ...rows.map(row => headers.map(h => escape(row[h])).join(","))].join("\n");
}
