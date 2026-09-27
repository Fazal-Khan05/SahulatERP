export const roles = ["Owner", "Accountant", "Sales Manager", "Salesperson", "Recovery Officer", "Warehouse Manager", "Payroll Administrator", "Auditor"] as const;
export type Role = typeof roles[number];
export type Currency = "PKR" | "USD" | "CNY";
export type Money = { amount: string; currency: Currency };
export type Status = "draft" | "submitted" | "cancelled";
export type Module = "dashboard" | "sales" | "purchasing" | "imports" | "inventory" | "collections" | "commissions" | "payroll" | "accounting" | "reports" | "settings";
export type Party = { id: string; name: string; type: "customer" | "supplier"; city: string; email: string; taxId: string; registered: boolean; creditLimit: string; terms: number; customerClass: string };
export type Item = { id: string; sku: string; name: string; category: string; hsCode: string; unit: string; price: string; cost: string; weight: string; volume: string; reorderLevel: number };
export type Employee = { id: string; name: string; role: string; territory: string; parentId?: string; salary: string; allowance: string; deduction: string; attendance: number; active: boolean };
export type Line = { id: string; itemId: string; quantity: string; price: string; discount: string; taxRate: string; employeeId: string; splits: { employeeId: string; share: string }[]; cost: string; returned: string };
export type Document = { id: string; number: string; kind: "quotation" | "sales_order" | "delivery" | "sales_invoice" | "credit_note" | "purchase_order" | "goods_receipt" | "supplier_invoice" | "supplier_return"; status: Status; partyId: string; warehouseId: string; date: string; dueDate: string; currency: Currency; fxRate: string; lines: Line[]; net: string; tax: string; total: string; paid: string; returned: string; parentId?: string; notes: string; taxSnapshot?: { registered: boolean; taxId: string; policy: string }; creditOverride?: string };
export type JournalLine = { account: string; debit: string; credit: string };
export type Journal = { id: string; number: string; sourceId: string; date: string; memo: string; status: "draft" | "posted"; lines: JournalLine[]; reversalOf?: string };
export type StockMove = { id: string; itemId: string; warehouseId: string; date: string; quantity: string; value: string; sourceId: string; type: string };
export type Receipt = { id: string; number: string; partyId: string; date: string; amount: string; method: "bank" | "cash" | "cheque"; status: "received" | "deposited" | "cleared" | "bounced"; chequeNo: string; dueDate: string; allocations: { invoiceId: string; amount: string }[]; employeeId: string; note: string };
export type CommissionPlan = { id: string; name: string; effectiveFrom: string; effectiveTo: string; type: "flat" | "category" | "customer_class" | "per_unit" | "tiered"; rate: string; categoryRates: Record<string,string>; classRates: Record<string,string>; tiers: { threshold: string; rate: string }[]; target: string; multiplier: string };
export type Commission = { id: string; invoiceId: string; lineId: string; employeeId: string; planSnapshot: CommissionPlan; eligibleBase: string; earned: string; released: string; paid: string; approved: boolean };
export type CommissionMovement = { id: string; commissionId: string; sourceId: string; date: string; type: "accrued" | "released" | "release_reversed" | "paid" | "entitlement_adjusted" | "recovery_recorded"; amount: string; note: string };
export type ShipmentCost = { id: string; label: string; amount: string; classification: "inventory" | "recoverable_tax" | "deposit" | "expense"; basis: "value" | "quantity" | "weight" | "volume"; allocated: boolean };
export type Shipment = { id: string; number: string; supplierId: string; documentId: string; origin: string; port: string; container: string; gdNumber: string; eta: string; status: "in_transit" | "customs" | "received" | "costed"; costs: ShipmentCost[]; allocations: { costId: string; itemId: string; amount: string }[] };
export type PayrollLine = { employeeId: string; basic: string; allowance: string; commission: string; deduction: string; employeeEobi: string; employerEobi: string; incomeTax: string; net: string; commissionIds: string[]; commissionAmounts: Record<string,string> };
export type Payroll = { id: string; number: string; month: string; date: string; status: "draft" | "reviewed" | "approved" | "paid"; lines: PayrollLine[]; total: string };
export type Fbr = { id: string; invoiceId: string; status: "not_required" | "queued" | "validating" | "accepted" | "rejected" | "outcome_unknown" | "reconciled"; attempts: number; reference: string; response: string; date: string };
export type Audit = { id: string; date: string; actor: string; role: string; action: string; sourceId: string; detail: string };
export type BankLine = { id: string; date: string; description: string; amount: string; matchedJournalId: string | null };
export type Workspace = {
  schemaVersion: 1; tenantId: string; revision: number; demo: boolean;
  company: { name: string; taxId: string; address: string; currency: "PKR"; logo: string };
  branches: {id: string; name: string}[]; warehouses: {id: string; name: string; branchId: string}[];
  parties: Party[]; items: Item[]; employees: Employee[]; documents: Document[]; journals: Journal[];
  stockMoves: StockMove[]; receipts: Receipt[]; plans: CommissionPlan[]; commissions: Commission[]; commissionMovements: CommissionMovement[];
  shipments: Shipment[]; payrolls: Payroll[]; fbr: Fbr[]; audit: Audit[]; bankLines: BankLine[];
  periods: {month: string; locked: boolean}[];
  settings: { taxRate: string; employerEobi: string; employeeEobi: string; eobiBase: string; incomeTaxRate: string; numbering: string; approvalLimit: string };
  operations: string[];
};
export type Actor = { id: string; name: string; role: Role; employeeId?: string; branchIds: string[] };
export const DEMO_TENANT = "11111111-1111-4111-8111-111111111111";
export const PARTNER_TENANT = "22222222-2222-4222-8222-222222222222";
export const accountNames: Record<string,string> = {
  "1000":"Bank & cash", "1100":"Accounts receivable", "1200":"Inventory", "1300":"Recoverable tax", "1400":"Deposits & advances",
  "2000":"Accounts payable", "2010":"Goods received, not billed", "2100":"Output tax payable", "2200":"Commission payable", "2300":"Payroll payable", "2400":"Statutory deductions payable",
  "3000":"Owner's capital", "4000":"Sales revenue", "5000":"Cost of goods sold", "5100":"Commission expense", "5200":"Salary expense", "5300":"Operating expense", "5400":"Exchange gain / loss"
};
