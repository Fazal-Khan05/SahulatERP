import { postAdjustment, postCount, postTransfer, saveAdjustmentDraft, saveCounts, saveTransferDraft, startCount, submitCount } from "@/modules/inventory/commands";
import { getStockCount } from "@/modules/inventory/queries";
import { createWarehouse } from "@/modules/warehouses/commands";
import type { Demo } from "../world";

// Stock: a second warehouse in Karachi (the shop counter) and a transfer to it, goods written
// off as damaged, a count posted with small differences, and a count finished and waiting.

export async function seedStock(d: Demo): Promise<void> {
  const { owner, accountant, warehouse, day } = d;
  // A transfer stays inside one branch, so the shop counter is a warehouse of the Karachi branch.
  d.shop = (await createWarehouse(owner, { name: "Karachi shop counter", branchId: d.karachiBranch })).id;
  const moved = await saveTransferDraft(warehouse, null, {
    date: day(1, 4), fromWarehouseId: d.karachi, toWarehouseId: d.shop, note: "Stock for the shop counter",
    lines: [{ itemCode: "AC-501", quantity: "20" }, { itemCode: "AC-530", quantity: "40" }, { itemCode: "LT-201", quantity: "100" }, { itemCode: "EN-301", quantity: "60" }, { itemCode: "AC-520", quantity: "50" }],
  });
  const transfer = await postTransfer(warehouse, moved.id);

  const broken = await saveAdjustmentDraft(accountant, "adjustment", null, { date: day(1, 9), warehouseId: d.karachi, reason: "damaged", note: "Two tail lights dropped while unloading", lines: [{ itemCode: "LT-220", direction: "out", quantity: "2" }] });
  const adjustment = await postAdjustment(accountant, broken.id);

  // The Lahore warehouse counted: three mud flaps short, two rim tapes over, the rest as the books say.
  const sheet = await startCount(warehouse, { date: day(1, 15), warehouseId: d.lahore, note: "Monthly count, Lahore" });
  const lines = (await getStockCount(warehouse, sheet.id))!.lines;
  const counted = lines
    .filter((line) => ["AC-520", "TY-420", "BR-101", "EN-301", "AC-530", "TY-411"].includes(line.code))
    .map((line) => ({ lineId: line.id, counted: (line.code === "AC-520" ? line.book.minus(3) : line.code === "TY-420" ? line.book.plus(2) : line.book).toFixed() }));
  await saveCounts(warehouse, sheet.id, { date: day(1, 15), note: "Monthly count, Lahore", lines: counted });
  await submitCount(warehouse, sheet.id);
  const count = await postCount(accountant, sheet.id, (await getStockCount(owner, sheet.id))!.updatedAt);

  Object.assign(d.facts, { transfer: transfer.number, adjustment: adjustment.number, stockCount: count.number });
  d.said.push(`Stock: ${transfer.number} moves goods to the shop counter; ${adjustment.number} writes off two damaged tail lights; ${count.number} is Lahore's count, three mud flaps short and two rim tapes over.`);
}

/** Left for the very end, so nothing moves the shop's stock after the sheet is started: a count finished by the warehouse and waiting for the owner or an accountant to post. */
export async function seedWaitingCount(d: Demo): Promise<void> {
  const sheet = await startCount(d.warehouse, { date: d.yesterday, warehouseId: d.shop, note: "Shop counter, weekly count" });
  const lines = (await getStockCount(d.warehouse, sheet.id))!.lines;
  await saveCounts(d.warehouse, sheet.id, { date: d.yesterday, note: "Shop counter, weekly count", lines: lines.map((line) => ({ lineId: line.id, counted: (line.code === "AC-530" ? line.book.minus(1) : line.book).toFixed() })) });
  await submitCount(d.warehouse, sheet.id);
  d.said.push("Stock: the shop counter's count is finished and waits to be posted (one handle grip pair short).");
}
