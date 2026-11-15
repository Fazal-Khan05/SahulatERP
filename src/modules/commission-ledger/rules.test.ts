import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { earnedAfterReturn, owedBack, payable, paymentOf, releasedFor, standingLabel, totalsOf, waiting } from "./rules";

const d = (value: string | number) => new Decimal(value);
const at = (earned: string, released: string, paid: string, approved = false) => ({ earned: d(earned), released: d(released), paid: d(paid), approved });

describe("where an accrual stands", () => {
  it("is waiting, payable or owed back by its three figures", () => {
    const part = at("200", "100", "0");
    expect([waiting(part).toFixed(2), payable(part).toFixed(2), owedBack(part).toFixed(2)]).toEqual(["100.00", "100.00", "0.00"]);
    // Paid, and then the cheque bounced: nothing is released, and what was paid is owed back.
    const bounced = at("200", "0", "200");
    expect([waiting(bounced).toFixed(2), payable(bounced).toFixed(2), owedBack(bounced).toFixed(2)]).toEqual(["200.00", "0.00", "200.00"]);
  });

  it("is said in words", () => {
    expect(standingLabel(at("200", "0", "0"))).toBe("Waiting for the customer to pay");
    expect(standingLabel(at("200", "100", "100"))).toBe("Part released");
    expect(standingLabel(at("200", "100", "0"))).toBe("Released, to approve");
    expect(standingLabel(at("200", "200", "0", true))).toBe("Approved for payment");
    expect(standingLabel(at("200", "200", "200"))).toBe("Paid");
    expect(standingLabel(at("200", "0", "200"))).toBe("Owed back");
    expect(standingLabel(at("0", "0", "0"))).toBe("Nothing earned");
  });

  it("adds up", () => {
    const totals = totalsOf([at("200", "200", "0", true), at("200", "100", "0"), at("100", "100", "200"), at("400", "0", "0")]);
    expect(Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toFixed(0)]))).toEqual({ earned: "900", released: "400", paid: "200", waiting: "500", payable: "300", approved: "200", owedBack: "100" });
  });
});

describe("what is earned and released", () => {
  it("comes down with the goods that come back", () => {
    // COM-035, COM-073.
    expect(earnedAfterReturn(d("200"), d("100"), d("50")).toFixed(4)).toBe("100.0000");
    expect(earnedAfterReturn(d("100"), d("10"), d("4")).toFixed(4)).toBe("60.0000");
    expect(earnedAfterReturn(d("200"), d("100"), d("100")).toFixed(4)).toBe("0.0000");
    expect(earnedAfterReturn(d("0.6666"), d("3"), d("1")).toFixed(4)).toBe("0.4444");
  });

  it("is released in the proportion of the invoice that has been collected", () => {
    // COM-017, COM-077, COM-078.
    expect(releasedFor(d("200"), d("5000"), d("10000")).toFixed(4)).toBe("100.0000");
    expect(releasedFor(d("0.6666"), d("11.11"), d("33.33")).toFixed(4)).toBe("0.2222");
    expect(releasedFor(d("200"), d("3333.33"), d("10000")).toFixed(4)).toBe("66.6666");
    expect(releasedFor(d("200"), d("10000"), d("10000")).toFixed(4)).toBe("200.0000");
    // COM-036: paid in full, then half comes back: all of what is left is released.
    expect(releasedFor(d("100"), d("10000"), d("5000")).toFixed(4)).toBe("100.0000");
    // Everything came back: nothing is left to collect, and nothing is released.
    expect(releasedFor(d("0"), d("10000"), d("0")).toFixed(4)).toBe("0.0000");
  });
});

describe("a payment", () => {
  it("is everything approved, less what is owed back as far as it goes", () => {
    const show = (p: ReturnType<typeof paymentOf>) => `${p.gross.toFixed(0)} - ${p.recovered.toFixed(0)} = ${p.amount.toFixed(0)}, ${p.carried.toFixed(0)} carried`;
    expect(show(paymentOf(d("200"), d("0")))).toBe("200 - 0 = 200, 0 carried");
    // COM-021: 400 approved, 200 owed back.
    expect(show(paymentOf(d("400"), d("200")))).toBe("400 - 200 = 200, 0 carried");
    // COM-037 as the founder decided it: 300 approved against 500 owed leaves 200 for the next payment.
    expect(show(paymentOf(d("300"), d("500")))).toBe("300 - 300 = 0, 200 carried");
  });
});
