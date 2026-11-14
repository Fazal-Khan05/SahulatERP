import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import Decimal from "decimal.js";
import { closeDb } from "@/db";
import { todayIso } from "@/lib/format";
import { savePlan, setManager } from "@/modules/commissions/commands";
import { setBaseCurrency } from "@/modules/currencies/commands";
import { postAdjustment, saveAdjustmentDraft } from "@/modules/inventory/commands";
import { addItemCategory, addUnit, createItem } from "@/modules/items/commands";
import { addAccount, seedAccounts } from "@/modules/ledger/commands";
import { openFiscalYear } from "@/modules/numbering/commands";
import { createParty } from "@/modules/parties/commands";
import { bounceCheque, clearCheque, depositCheque, postReceipt, saveReceiptDraft } from "@/modules/receipts/commands";
import { addFollowUp, addPromise } from "@/modules/recovery/commands";
import { postDelivery, postInvoice, saveDeliveryDraft, saveInvoiceDraft, saveSalesDraft, startDelivery, startInvoice, submitSalesDocument } from "@/modules/sales/commands";
import { getSalesDocument } from "@/modules/sales/queries";
import { recordSetup, withSetupLock } from "@/modules/setup/commands";
import { MODULE_BUNDLES, readSetup } from "@/modules/setup/rules";
import { createBranch, createCompany, setModuleEnabled } from "@/modules/tenant/commands";
import { MODULES, type MemberRole, type TenantContext } from "@/modules/tenant/rules";
import { createWarehouse } from "@/modules/warehouses/commands";
import { adminSql, deleteTenants, type AdminSql } from "../../tests/support/admin-db";

// The demo company: an invented motorcycle-parts importer with two months of trading, built
// through the app's own commands and posting functions, exactly as people would through the
// screens. Nothing here writes a document, a stock move or a journal itself. Run by
// `npm run demo:seed`; `npm run demo:reset` removes it again. Every name in it is made up.
//
// The logins are created through the Supabase admin API with generated passwords, written to
// .env.demo-accounts.local (git-ignored) and never printed.

export const DEMO_COMPANY = "Shaheen Bike Parts (Demo)";
const DOMAIN = "demo.sahulaterp.test";
const ACCOUNTS_FILE = ".env.demo-accounts.local";
export const DEMO_LOGINS = [
  { key: "OWNER", local: "demo-owner", role: "owner" as MemberRole, label: "Owner" },
  { key: "MANAGER", local: "demo-manager", role: "sales_manager" as MemberRole, label: "Sales manager (Imran)" },
  { key: "ALI", local: "demo-ali", role: "salesperson" as MemberRole, label: "Salesperson (Ali)" },
  { key: "SANA", local: "demo-sana", role: "salesperson" as MemberRole, label: "Salesperson (Sana)" },
] as const;
const emailOf = (local: string) => `${local}@${DOMAIN}`;

function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("The Supabase URL or service-role key is not set in .env.local.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The demo company's id and its logins' ids, as far as they exist. */
async function findDemo(sql: AdminSql): Promise<{ tenantIds: string[]; userIds: string[] }> {
  const users = await sql<{ id: string }[]>`select id from auth.users where email = any(${DEMO_LOGINS.map((login) => emailOf(login.local))})`;
  const tenants = await sql<{ id: string }[]>`select id from public.tenants where name = ${DEMO_COMPANY}`;
  return { tenantIds: tenants.map((t) => t.id), userIds: users.map((u) => u.id) };
}

/** Days are counted in Pakistan, as the app counts them. */
const shift = (iso: string, days: number) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + days)).toISOString().slice(0, 10);

export async function seedDemo(): Promise<string[]> {
  const sql = adminSql();
  const said: string[] = [];
  try {
    const found = await findDemo(sql);
    if (found.tenantIds.length > 0 || found.userIds.length > 0) throw new Error("The demo company already exists. Run npm run demo:reset first.");
    if (existsSync(ACCOUNTS_FILE)) throw new Error(`${ACCOUNTS_FILE} already exists. Remove it, or run npm run demo:reset, first.`);

    // ── The logins ──────────────────────────────────────────────────────────────────────────────
    const supabase = supabaseAdmin();
    const people: Record<string, { id: string; email: string; password: string }> = {};
    for (const login of DEMO_LOGINS) {
      const email = emailOf(login.local);
      const password = `${randomBytes(15).toString("base64url")}aA1`;
      const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: login.role === "owner" ? { can_create_company: true } : {} });
      if (error || !data.user) throw new Error(`Could not create the login ${email}: ${error?.message}`);
      people[login.key] = { id: data.user.id, email, password };
    }
    writeFileSync(
      ACCOUNTS_FILE,
      [
        `# Demo logins for "${DEMO_COMPANY}", made by npm run demo:seed. Never commit or share this file.`,
        ...DEMO_LOGINS.flatMap((login) => [`# ${login.label}`, `DEMO_${login.key}_EMAIL=${people[login.key].email}`, `DEMO_${login.key}_PASSWORD=${people[login.key].password}`]),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    said.push(`Logins created; their passwords are in ${ACCOUNTS_FILE}.`);

    // ── The company, as the setup wizard makes it ───────────────────────────────────────────────
    const today = todayIso(new Date());
    const thisMonth = `${today.slice(0, 8)}01`;
    const lastMonth = shift(thisMonth, -1).slice(0, 8) + "01";
    const yesterday = shift(today, -1);
    // A day in last month (0) or this month (1), never later than yesterday.
    const day = (month: 0 | 1, n: number) => {
      const date = shift(month === 0 ? lastMonth : thisMonth, n - 1);
      return date > yesterday ? yesterday : date;
    };
    const fyYear = +lastMonth.slice(5, 7) >= 7 ? +lastMonth.slice(0, 4) : +lastMonth.slice(0, 4) - 1;

    const tenantId = await createCompany({ id: people.OWNER.id, email: people.OWNER.email }, DEMO_COMPANY);
    const as = (key: string, role: MemberRole): TenantContext => ({ userId: people[key].id, email: people[key].email, tenantId, tenantName: DEMO_COMPANY, role, branchIds: null });
    const owner = as("OWNER", "owner");
    const read = readSetup({ salesTaxRegistered: "no", currencyCode: "PKR", currencyName: "Pakistani Rupee", fiscalMonth: "7", fiscalYear: String(fyYear), bundle: "trading", branchName: "Karachi", warehouseName: "Karachi warehouse", accountsTemplate: "trading" });
    if (!read.ok) throw new Error(read.reason);
    let karachi = "";
    await withSetupLock(owner, async () => {
      await setBaseCurrency(owner, read.setup.baseCurrency);
      await openFiscalYear(owner, { month: "7", year: String(fyYear) }, { onlyFirst: true });
      const branch = await createBranch(owner, "Karachi");
      karachi = (await createWarehouse(owner, { name: "Karachi warehouse", branchId: branch.id })).id;
      await seedAccounts(owner, "trading");
      const wanted = MODULE_BUNDLES.trading.modules;
      await recordSetup(owner, read.setup, { baseCurrency: "PKR", fiscalYearStart: read.setup.fiscalYearStart, branch: "Karachi", warehouse: "Karachi warehouse", modules: MODULES.filter((key) => wanted[key]) });
    });
    // The same trading bundle, with commissions on: this importer pays its sales team commission.
    for (const key of MODULES) {
      const on = MODULE_BUNDLES.trading.modules[key] || key === "commissions";
      await setModuleEnabled(owner, key, on);
    }
    const lahoreBranch = await createBranch(owner, "Lahore");
    const lahore = (await createWarehouse(owner, { name: "Lahore warehouse", branchId: lahoreBranch.id })).id;
    // The sales team joins the company (as accepting an invitation would make them members).
    await sql`insert into public.memberships ${sql(
      DEMO_LOGINS.filter((login) => login.role !== "owner").map((login) => ({ tenant_id: tenantId, user_id: people[login.key].id, email: people[login.key].email, role: login.role, branch_ids: null, created_by: people.OWNER.id })),
    )}`;
    const manager = as("MANAGER", "sales_manager");
    const ali = as("ALI", "salesperson");
    const sana = as("SANA", "salesperson");
    said.push(`Company "${DEMO_COMPANY}" set up: two branches, Karachi and Lahore.`);

    // ── Items: five categories, thirty parts ────────────────────────────────────────────────────
    const piece = (await addUnit(owner, { code: "pc", name: "Piece" })).id;
    const set = (await addUnit(owner, { code: "set", name: "Set" })).id;
    const categories: Record<string, string> = {};
    for (const name of ["Brakes", "Lighting", "Engine parts", "Tyres and tubes", "Accessories"]) categories[name] = (await addItemCategory(owner, name)).id;
    // code, name, category, unit, price, cost, reorder level, opening quantity in Karachi, in Lahore
    const ITEMS: [string, string, string, string, number, number, number, number, number][] = [
      ["BR-101", "Brake shoe, 70cc rear", "Brakes", piece, 450, 300, 50, 400, 150],
      ["BR-102", "Brake shoe, 125cc rear", "Brakes", piece, 520, 340, 40, 300, 100],
      ["BR-110", "Disc brake pad, front", "Brakes", set, 1350, 900, 20, 120, 40],
      ["BR-120", "Brake cable, rear", "Brakes", piece, 260, 160, 60, 500, 200],
      ["BR-130", "Brake lever, chrome", "Brakes", piece, 380, 230, 30, 150, 60],
      ["BR-140", "Brake drum, 70cc", "Brakes", piece, 2400, 1700, 10, 40, 15],
      ["LT-201", "Headlight bulb, 12V 35W", "Lighting", piece, 220, 120, 100, 800, 300],
      ["LT-202", "Indicator set, amber", "Lighting", set, 950, 600, 25, 120, 50],
      ["LT-210", "LED headlight unit", "Lighting", piece, 3800, 2600, 10, 45, 20],
      ["LT-220", "Tail light assembly", "Lighting", piece, 1450, 950, 15, 80, 30],
      ["LT-230", "Horn, 12V dual tone", "Lighting", piece, 1150, 720, 20, 90, 40],
      ["LT-240", "Wiring harness, 70cc", "Lighting", piece, 2900, 2000, 8, 30, 10],
      ["EN-301", "Spark plug, standard", "Engine parts", piece, 350, 210, 100, 900, 300],
      ["EN-302", "Piston kit, 70cc std", "Engine parts", set, 4200, 3000, 10, 60, 20],
      ["EN-310", "Clutch plate set, 70cc", "Engine parts", set, 1850, 1250, 20, 110, 40],
      ["EN-320", "Chain sprocket kit, 70cc", "Engine parts", set, 3100, 2150, 15, 90, 30],
      ["EN-330", "Air filter, 125cc", "Engine parts", piece, 420, 250, 50, 300, 120],
      ["EN-340", "Carburettor, 70cc", "Engine parts", piece, 5600, 4000, 5, 25, 10],
      ["EN-350", "Gasket set, 125cc", "Engine parts", set, 780, 480, 30, 200, 80],
      ["TY-401", "Tyre 2.75-17, rear", "Tyres and tubes", piece, 4100, 3200, 20, 120, 50],
      ["TY-402", "Tyre 2.50-17, front", "Tyres and tubes", piece, 3600, 2800, 20, 110, 40],
      ["TY-410", "Tube 2.75-17", "Tyres and tubes", piece, 650, 430, 60, 400, 150],
      ["TY-411", "Tube 2.50-17", "Tyres and tubes", piece, 600, 400, 60, 380, 140],
      ["TY-420", "Rim tape, 17 inch", "Tyres and tubes", piece, 90, 45, 100, 600, 200],
      ["AC-501", "Helmet, open face", "Accessories", piece, 2200, 1450, 15, 100, 40],
      ["AC-502", "Side mirror pair", "Accessories", set, 700, 420, 30, 220, 90],
      ["AC-510", "Seat cover, 70cc", "Accessories", piece, 850, 520, 25, 150, 60],
      ["AC-520", "Mud flap, rubber", "Accessories", piece, 180, 90, 80, 500, 200],
      ["AC-530", "Handle grip pair", "Accessories", set, 320, 180, 50, 350, 120],
      ["AC-540", "Chain lock, heavy", "Accessories", piece, 1250, 800, 15, 70, 25],
    ];
    const itemIds: Record<string, string> = {};
    for (const [code, name, category, unit, price, , reorder] of ITEMS) {
      itemIds[code] = (await createItem(owner, { code, name, unit, category: categories[category], defaultPrice: String(price), reorderLevel: String(reorder) })).id;
    }
    // Opening stock, at its cost, on the first day of last month.
    for (const [warehouseId, column] of [[karachi, 7], [lahore, 8]] as const) {
      const { id } = await saveAdjustmentDraft(owner, "opening", null, {
        date: lastMonth,
        warehouseId,
        note: "Stock counted when the company started using the app",
        lines: ITEMS.map((item) => ({ itemCode: item[0], direction: "in", quantity: String(item[column]), unitCost: String(item[5]) })),
      });
      await postAdjustment(owner, id);
    }
    said.push(`${ITEMS.length} items in 5 categories, with opening stock in both warehouses.`);

    // ── Customers in three classes ──────────────────────────────────────────────────────────────
    // name, code, class, credit days, city, province
    const CUSTOMERS: [string, string, string, number, string, string][] = [
      ["Faisal Motors", "C-001", "Wholesaler", 30, "Karachi", "sindh"],
      ["Rehman Autos", "C-002", "Wholesaler", 30, "Karachi", "sindh"],
      ["Hyderabad Bike Mart", "C-003", "Wholesaler", 45, "Hyderabad", "sindh"],
      ["Gulshan Spare Parts", "C-004", "Retailer", 15, "Karachi", "sindh"],
      ["Saddar Cycle House", "C-005", "Retailer", 15, "Karachi", "sindh"],
      ["Korangi Workshop", "C-006", "Workshop", 7, "Karachi", "sindh"],
      ["Anarkali Auto Store", "C-007", "Wholesaler", 30, "Lahore", "punjab"],
      ["Model Town Motors", "C-008", "Retailer", 15, "Lahore", "punjab"],
      ["Ravi Road Workshop", "C-009", "Workshop", 7, "Lahore", "punjab"],
      ["Gujranwala Parts Centre", "C-010", "Wholesaler", 30, "Gujranwala", "punjab"],
    ];
    const customers: Record<string, string> = {};
    for (const [name, code, customerClass, creditDays, city, province] of CUSTOMERS) {
      customers[code] = (
        await createParty(owner, "customer", { name, code, customerClass, creditDays: String(creditDays), city, province, address: `Shop ${code.slice(2)}, Main Bazaar`, contactName: "Accounts", email: `accounts-${code.toLowerCase()}@${DOMAIN}` })
      ).id;
    }
    said.push(`${CUSTOMERS.length} customers: wholesalers, retailers and workshops in Karachi and Lahore.`);

    // ── Commission plans and the sales team ─────────────────────────────────────────────────────
    const fyStart = `${fyYear}-07-01`;
    await savePlan(owner, null, { name: "Standard plan", kind: "category", rate: "2", categoryRates: [{ categoryId: categories.Lighting, rate: "3" }, { categoryId: categories["Tyres and tubes"], rate: "1.5" }], from: fyStart, to: "" });
    await savePlan(owner, null, { name: "Ali: slabs", userId: people.ALI.id, kind: "tiered", tiers: [{ threshold: "0", rate: "2" }, { threshold: "300000", rate: "3" }], from: fyStart, to: "" });
    await savePlan(owner, null, { name: "Sana: monthly target", userId: people.SANA.id, kind: "flat", rate: "2", target: "150000", multiplier: "1.5", from: fyStart, to: "" });
    await savePlan(owner, null, { name: "Imran: area manager", userId: people.MANAGER.id, kind: "flat", rate: "1", teamRate: "0.5", from: fyStart, to: "" });
    await setManager(owner, people.ALI.id, people.MANAGER.id);
    await setManager(owner, people.SANA.id, people.MANAGER.id);
    said.push("Commission: a standard plan by category, Ali on slabs, Sana with a monthly target, both under Imran.");

    // ── Two months of selling ───────────────────────────────────────────────────────────────────
    type Flow = "quotation" | "order" | "delivered" | "invoiced" | "direct";
    type Sale = { month: 0 | 1; day: number; who: "ALI" | "SANA" | "SPLIT"; customer: string; warehouse: "K" | "L"; lines: [string, number][]; flow: Flow };
    const SALES: Sale[] = [
      { month: 0, day: 2, who: "ALI", customer: "C-001", warehouse: "K", lines: [["BR-101", 100], ["BR-120", 80], ["LT-201", 150]], flow: "invoiced" },
      { month: 0, day: 3, who: "SANA", customer: "C-004", warehouse: "K", lines: [["TY-401", 6], ["TY-410", 20], ["AC-501", 4]], flow: "direct" },
      { month: 0, day: 5, who: "ALI", customer: "C-002", warehouse: "K", lines: [["EN-301", 120], ["EN-330", 40], ["EN-350", 25]], flow: "invoiced" },
      { month: 0, day: 7, who: "SPLIT", customer: "C-003", warehouse: "K", lines: [["TY-401", 20], ["TY-402", 18], ["TY-410", 60], ["TY-411", 60]], flow: "invoiced" },
      { month: 0, day: 9, who: "SANA", customer: "C-007", warehouse: "L", lines: [["LT-210", 6], ["LT-220", 10], ["LT-202", 12]], flow: "invoiced" },
      { month: 0, day: 11, who: "ALI", customer: "C-006", warehouse: "K", lines: [["EN-310", 8], ["EN-320", 5], ["BR-110", 6]], flow: "direct" },
      { month: 0, day: 14, who: "SANA", customer: "C-008", warehouse: "L", lines: [["AC-502", 30], ["AC-530", 40], ["AC-510", 15]], flow: "invoiced" },
      { month: 0, day: 16, who: "ALI", customer: "C-001", warehouse: "K", lines: [["EN-302", 10], ["EN-340", 4], ["BR-140", 6]], flow: "invoiced" },
      { month: 0, day: 19, who: "SANA", customer: "C-010", warehouse: "L", lines: [["TY-401", 10], ["TY-402", 10], ["BR-101", 60]], flow: "invoiced" },
      { month: 0, day: 22, who: "ALI", customer: "C-005", warehouse: "K", lines: [["LT-201", 60], ["LT-230", 8], ["AC-520", 50]], flow: "direct" },
      { month: 0, day: 25, who: "SANA", customer: "C-009", warehouse: "L", lines: [["EN-301", 50], ["EN-330", 20], ["BR-102", 20]], flow: "invoiced" },
      { month: 0, day: 27, who: "ALI", customer: "C-002", warehouse: "K", lines: [["LT-210", 8], ["LT-240", 4], ["LT-202", 10]], flow: "invoiced" },
      { month: 1, day: 2, who: "ALI", customer: "C-001", warehouse: "K", lines: [["BR-101", 120], ["BR-102", 80], ["BR-110", 20]], flow: "invoiced" },
      { month: 1, day: 3, who: "SANA", customer: "C-007", warehouse: "L", lines: [["TY-401", 12], ["TY-410", 40], ["AC-501", 10]], flow: "invoiced" },
      { month: 1, day: 4, who: "SPLIT", customer: "C-003", warehouse: "K", lines: [["EN-320", 15], ["EN-310", 12], ["EN-301", 80]], flow: "direct" },
      { month: 1, day: 6, who: "ALI", customer: "C-004", warehouse: "K", lines: [["LT-220", 10], ["LT-201", 80]], flow: "delivered" },
      { month: 1, day: 7, who: "SANA", customer: "C-008", warehouse: "L", lines: [["AC-540", 10], ["AC-502", 20]], flow: "order" },
      { month: 1, day: 8, who: "ALI", customer: "C-006", warehouse: "K", lines: [["EN-340", 3], ["EN-302", 4]], flow: "quotation" },
      { month: 1, day: 9, who: "SANA", customer: "C-010", warehouse: "L", lines: [["TY-402", 8], ["TY-411", 30]], flow: "quotation" },
    ];
    const invoices: { customer: string; id: string; number: string; total: Decimal; month: 0 | 1 }[] = [];
    let documents = 0;
    for (const sale of SALES) {
      const date = day(sale.month, sale.day);
      const writer = sale.who === "SANA" ? sana : ali;
      const shares = sale.who === "SPLIT" ? [{ userId: people.ALI.id, percent: "60" }, { userId: people.SANA.id, percent: "40" }] : [{ userId: people[sale.who].id, percent: "100" }];
      const kind = sale.flow === "quotation" ? "quotation" : "order";
      const { id } = await saveSalesDraft(writer, null, {
        kind,
        date,
        validUntil: kind === "quotation" ? shift(date, 15) : "",
        customerId: customers[sale.customer],
        warehouseId: sale.warehouse === "K" ? karachi : lahore,
        lines: sale.lines.map(([code, quantity]) => ({ itemId: itemIds[code], quantity: String(quantity), unitId: "", unitPrice: "", discountPercent: "", description: "" })),
        shares,
      });
      await submitSalesDocument(writer, id);
      documents += 1;
      if (sale.flow === "quotation" || sale.flow === "order") continue;
      let billFrom = id;
      if (sale.flow !== "direct") {
        const note = (await startDelivery(owner, id)).id;
        const draft = (await getSalesDocument(owner, note))!;
        await saveDeliveryDraft(owner, note, { date: shift(date, 1) > yesterday ? date : shift(date, 1), lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
        await postDelivery(owner, note);
        documents += 1;
        if (sale.flow === "delivered") continue;
        billFrom = note;
      }
      const invoice = (await startInvoice(owner, billFrom)).id;
      const draft = (await getSalesDocument(owner, invoice))!;
      const invoiceDate = sale.flow === "direct" ? date : shift(date, 1) > yesterday ? date : shift(date, 1);
      await saveInvoiceDraft(owner, invoice, { date: invoiceDate, lines: draft.lines.map((l) => ({ sourceLineId: l.sourceLineId, quantity: l.quantity.toFixed() })) });
      const { number } = await postInvoice(owner, invoice);
      const posted = (await getSalesDocument(owner, invoice))!;
      invoices.push({ customer: sale.customer, id: invoice, number, total: posted.totals.total, month: sale.month });
      documents += 1;
    }
    said.push(`${documents} sales documents: quotations, orders, delivery notes and ${invoices.length} invoices, some split 60/40 between Ali and Sana.`);

    // ── Money in: cash, bank and cheques ────────────────────────────────────────────────────────
    const [{ id: cash }] = await sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and code = '1111'`;
    const [{ id: banks }] = await sql<{ id: string }[]>`select id from public.accounts where tenant_id = ${tenantId} and code = '1120'`;
    const bank = (await addAccount(owner, { parentId: banks, name: "Meezan Bank current account", code: "", kind: "account" })).id;
    const last = invoices.filter((i) => i.month === 0);
    const pay = (invoice: (typeof invoices)[number], amount: Decimal) => ({ kind: "invoice", id: invoice.id, amount: amount.toFixed(2) });
    const receive = async (date: string, invoice: (typeof invoices)[number], method: "cash" | "bank" | "cheque", amount: Decimal, cheque?: { number: string; bank: string }) => {
      const { id } = await saveReceiptDraft(owner, null, {
        date,
        customerId: customers[invoice.customer],
        method,
        accountId: method === "cash" ? cash : method === "bank" ? bank : "",
        amount: amount.toFixed(2),
        chequeNumber: cheque?.number ?? "",
        chequeBank: cheque?.bank ?? "",
        chequeDate: cheque ? date : "",
        allocations: [pay(invoice, amount)],
      });
      await postReceipt(owner, id);
      return id;
    };
    const halfOf = (total: Decimal) => total.div(2).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    // Last month's first invoices paid in full, by cash and by bank; one paid half.
    await receive(day(0, 20), last[0], "cash", last[0].total);
    await receive(day(0, 24), last[1], "bank", last[1].total);
    await receive(day(1, 3), last[2], "bank", halfOf(last[2].total));
    // A cheque deposited and cleared.
    const cleared = await receive(day(1, 2), last[3], "cheque", last[3].total, { number: "00451872", bank: "HBL" });
    await depositCheque(owner, cleared, { accountId: bank, date: day(1, 3) });
    await clearCheque(owner, cleared, { date: day(1, 5) });
    // A cheque deposited that bounced: the invoice is unpaid again.
    const bounced = await receive(day(1, 4), last[4], "cheque", last[4].total, { number: "00872210", bank: "UBL" });
    await depositCheque(owner, bounced, { accountId: bank, date: day(1, 5) });
    await bounceCheque(owner, bounced, { date: day(1, 8), reason: "Insufficient funds" });
    // A cheque still in hand, not yet deposited.
    await receive(day(1, 10), last[5], "cheque", last[5].total, { number: "00117345", bank: "Bank Alfalah" });
    said.push("Receipts: cash, bank transfer, a cheque cleared, a cheque bounced and a cheque still in hand.");

    // ── Recovery: a follow-up and a promise ─────────────────────────────────────────────────────
    const chased = last[4].customer;
    await addFollowUp(manager, customers[chased], { note: "Called about the bounced cheque. They will pay by bank transfer next week.", nextOn: shift(today, 3) }, today);
    await addPromise(manager, customers[chased], { amount: last[4].total.toFixed(2), promisedOn: shift(today, 7), note: "Bank transfer" }, today);
    await addFollowUp(owner, customers[last[6].customer], { note: "Asked for payment; they asked for a statement first.", nextOn: today }, today);
    said.push("Recovery: follow-ups, and a promise to pay for the bounced cheque.");
    return said;
  } finally {
    await sql.end();
    await closeDb();
  }
}

/** Removes the demo company and its logins, and only those. */
export async function resetDemo(): Promise<string[]> {
  const sql = adminSql();
  try {
    const found = await findDemo(sql);
    // Only the companies the demo owner made, so that nothing else with the same name is touched.
    const owned = found.userIds.length === 0 ? [] : await sql<{ id: string }[]>`select id from public.tenants where name = ${DEMO_COMPANY} and created_by = any(${found.userIds})`;
    await deleteTenants(sql, owned.map((t) => t.id));
    const supabase = supabaseAdmin();
    for (const id of found.userIds) {
      const { error } = await supabase.auth.admin.deleteUser(id);
      if (error) throw new Error(`Could not remove a demo login: ${error.message}`);
    }
    if (existsSync(ACCOUNTS_FILE)) writeFileSync(ACCOUNTS_FILE, "");
    return [`Removed ${owned.length} demo company and ${found.userIds.length} demo logins.`];
  } finally {
    await sql.end();
    await closeDb();
  }
}
