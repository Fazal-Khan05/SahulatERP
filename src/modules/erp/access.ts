import type { Actor, Document, Role, Workspace } from "./types";

// Roles that read the complete books. Everyone else receives a projection limited to their work.
export const ledgerRoles: Role[] = ["Owner", "Accountant", "Auditor"];
const payRoles: Role[] = [...ledgerRoles, "Payroll Administrator"];
const salesKinds: Document["kind"][] = ["quotation", "sales_order", "delivery", "sales_invoice", "credit_note"];
const warehouseKinds: Document["kind"][] = ["purchase_order", "goods_receipt", "supplier_invoice", "supplier_return", "delivery"];

export function canReadLedger(role: Role) { return ledgerRoles.includes(role); }

/**
 * Returns only the data the actor's role and branches allow. The UI hides modules, but the
 * server must not send what a role may not see: salaries, payroll, journals and other branches.
 */
export function scopeWorkspace(source: Workspace, actor: Actor): Workspace {
  const role = actor.role;
  const w: Workspace = { ...source, operations: [] };
  const branchLimited = actor.branchIds.length > 0;
  const warehouseIds = new Set(source.warehouses.filter(x => !branchLimited || actor.branchIds.includes(x.branchId)).map(x => x.id));
  if (branchLimited) {
    w.branches = source.branches.filter(x => actor.branchIds.includes(x.id));
    w.warehouses = source.warehouses.filter(x => warehouseIds.has(x.id));
  }
  if (canReadLedger(role) && !branchLimited) return { ...w, operations: source.operations };

  let documents = source.documents.filter(d => warehouseIds.has(d.warehouseId));
  if (role === "Sales Manager" || role === "Recovery Officer") documents = documents.filter(d => salesKinds.includes(d.kind));
  if (role === "Salesperson") documents = documents.filter(d => salesKinds.includes(d.kind) && !!actor.employeeId && d.lines.some(l => l.employeeId === actor.employeeId || l.splits.some(x => x.employeeId === actor.employeeId)));
  if (role === "Warehouse Manager") documents = documents.filter(d => warehouseKinds.includes(d.kind));
  if (role === "Payroll Administrator") documents = documents.filter(d => d.kind === "sales_invoice");
  const documentIds = new Set(documents.map(d => d.id));

  const commissionsVisible = ["Sales Manager", "Salesperson", "Payroll Administrator"].includes(role) || canReadLedger(role);
  let commissions = commissionsVisible ? source.commissions.filter(c => documentIds.has(c.invoiceId)) : [];
  if (role === "Salesperson") commissions = commissions.filter(c => c.employeeId === actor.employeeId);
  const commissionIds = new Set(commissions.map(c => c.id));

  const partyIds = new Set(documents.map(d => d.partyId));
  const parties = source.parties.filter(p => {
    if (role === "Warehouse Manager") return p.type === "supplier" || partyIds.has(p.id);
    if (role === "Payroll Administrator") return partyIds.has(p.id);
    if (role === "Salesperson") return p.type === "customer";
    return canReadLedger(role) || p.type === "customer";
  });

  const employees = payRoles.includes(role)
    ? source.employees
    : ["Sales Manager", "Salesperson"].includes(role)
      ? source.employees.map(e => ({ ...e, salary: "0", allowance: "0", deduction: "0", attendance: 0 }))
      : [];

  const stockVisible = ["Warehouse Manager", "Sales Manager", "Salesperson"].includes(role) || canReadLedger(role);
  return {
    ...w,
    parties,
    employees,
    documents,
    commissions,
    commissionMovements: source.commissionMovements.filter(m => commissionIds.has(m.commissionId)),
    plans: commissionsVisible ? source.plans : [],
    receipts: ["Sales Manager", "Recovery Officer", "Salesperson"].includes(role) || canReadLedger(role)
      ? source.receipts.filter(r => r.allocations.every(a => documentIds.has(a.invoiceId)))
      : [],
    stockMoves: stockVisible ? source.stockMoves.filter(m => warehouseIds.has(m.warehouseId)) : [],
    shipments: role === "Warehouse Manager" || canReadLedger(role) ? source.shipments.filter(s => documentIds.has(s.documentId)) : [],
    payrolls: payRoles.includes(role) && !branchLimited ? source.payrolls : [],
    journals: canReadLedger(role) && !branchLimited ? source.journals : [],
    audit: canReadLedger(role) && !branchLimited ? source.audit : [],
    followUps: ["Sales Manager", "Recovery Officer"].includes(role) || canReadLedger(role) ? source.followUps.filter(f => parties.some(p => p.id === f.partyId)) : [],
    // Account names are needed to record a receipt; balances come from journals, which are already scoped.
    bankAccounts: source.bankAccounts,
  };
}

/** Owner/Accountant view of one branch's operations. Journals stay company-wide; callers must not present them as branch figures. */
export function filterBranch(source: Workspace, branchId: string): Workspace {
  const warehouseIds = new Set(source.warehouses.filter(x => x.branchId === branchId).map(x => x.id));
  const documents = source.documents.filter(d => warehouseIds.has(d.warehouseId));
  const documentIds = new Set(documents.map(d => d.id));
  const commissions = source.commissions.filter(c => documentIds.has(c.invoiceId));
  const commissionIds = new Set(commissions.map(c => c.id));
  return {
    ...source,
    warehouses: source.warehouses.filter(x => warehouseIds.has(x.id)),
    documents,
    stockMoves: source.stockMoves.filter(m => warehouseIds.has(m.warehouseId)),
    receipts: source.receipts.filter(r => r.allocations.every(a => documentIds.has(a.invoiceId))),
    shipments: source.shipments.filter(s => documentIds.has(s.documentId)),
    commissions,
    commissionMovements: source.commissionMovements.filter(m => commissionIds.has(m.commissionId)),
  };
}
