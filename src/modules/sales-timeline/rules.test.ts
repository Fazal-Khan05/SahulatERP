import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineFacts } from "./rules";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 14, 9, minute));
const names: Record<string, string> = { owner: "owner@example.test", sam: "sam@example.test" };
const nameOf = (id: string) => names[id] ?? "Another member";

const base: TimelineFacts = {
  kind: "order",
  createdAt: at(0),
  createdBy: "sam",
  madeFrom: null,
  heldAt: null,
  heldBy: null,
  submittedAt: null,
  submittedBy: null,
  overrideBy: null,
  overrideReason: null,
  cancelledAt: null,
  cancelledBy: null,
  cancelReason: null,
  madeInto: [],
  emails: [],
};

describe("buildTimeline", () => {
  it("starts with who wrote the document, and what it was made from", () => {
    const events = buildTimeline({ ...base, madeFrom: { kind: "quotation", number: "QT-2627-00001" } }, nameOf);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ what: "Written from quotation QT-2627-00001", who: "sam@example.test" });
  });

  it("tells an order held over the credit limit and approved by the owner, in order", () => {
    const events = buildTimeline({ ...base, heldAt: at(1), heldBy: "sam", submittedAt: at(5), submittedBy: "owner", overrideBy: "owner", overrideReason: "cheque due Monday" }, nameOf);
    expect(events.map((e) => e.what)).toEqual(["Written", "Held for the owner: over the customer's credit limit", "Approved over the credit limit: cheque due Monday", "Submitted"]);
    expect(events[3].who).toBe("owner@example.test");
  });

  it("says posted for a delivery note or an invoice", () => {
    expect(buildTimeline({ ...base, kind: "invoice", submittedAt: at(2), submittedBy: "sam" }, nameOf)[1].what).toBe("Posted");
    expect(buildTimeline({ ...base, kind: "delivery", submittedAt: at(2), submittedBy: "sam" }, nameOf)[1].what).toBe("Posted");
  });

  it("puts the documents made from it and its emails where they happened, with the cancellation last", () => {
    const events = buildTimeline(
      {
        ...base,
        kind: "quotation",
        submittedAt: at(1),
        submittedBy: "sam",
        madeInto: [{ id: "o1", kind: "order", number: null, status: "draft", createdAt: at(3) }],
        emails: [
          { id: "e1", at: at(2), by: "sam", to: "buyer@example.test", status: "sent", error: null },
          { id: "e2", at: at(4), by: "stranger", to: "buyer@example.test", status: "unknown", error: "x" },
          { id: "e3", at: at(5), by: "sam", to: "buyer@example.test", status: "failed", error: "The address does not exist." },
        ],
        cancelledAt: at(6),
        cancelledBy: "owner",
        cancelReason: "customer changed their mind",
      },
      nameOf,
    );
    expect(events.map((e) => e.what)).toEqual([
      "Written",
      "Submitted",
      "Emailed to buyer@example.test",
      "Sales order made from this",
      "Email to buyer@example.test: not known whether it arrived",
      "Email to buyer@example.test failed: The address does not exist.",
      "Cancelled: customer changed their mind",
    ]);
    expect(events[3].link).toEqual({ href: "/sales/o1", label: "Sales order (draft)" });
    expect(events[4]).toMatchObject({ who: "Another member", unsettledEmailId: "e2", tone: "warn" });
  });
});
