import { KIND_LABELS, type SalesKind, type SalesStatus } from "@/modules/sales/rules";

// Pure rules for a sales document's timeline: what happened to it, in order. No I/O.
//
// The timeline is read from the document itself (who wrote, held, approved, submitted or
// cancelled it, and when), the documents made from it, and its emails. The audit log holds the
// same and more, but only an owner or an auditor may read it.

export type TimelineFacts = {
  kind: SalesKind;
  createdAt: Date;
  createdBy: string;
  madeFrom: { kind: SalesKind; number: string | null } | null;
  heldAt: Date | null;
  heldBy: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  overrideBy: string | null;
  overrideReason: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  madeInto: { id: string; kind: SalesKind; number: string | null; status: SalesStatus; createdAt: Date }[];
  emails: { id: string; at: Date; by: string; to: string; status: "sending" | "sent" | "failed" | "unknown"; error: string | null }[];
};

export type TimelineEvent = {
  at: Date;
  what: string;
  /** Who did it, by name; null when the event is no one's doing. */
  who: string | null;
  tone: "plain" | "good" | "warn";
  /** Another document the event is about. */
  link: { href: string; label: string } | null;
  /** An email whose outcome a member must settle. */
  unsettledEmailId: string | null;
};

const posts = (kind: SalesKind) => kind === "delivery" || kind === "invoice";

/** The document's timeline, oldest first. `nameOf` gives a member's name, or a stand-in for one the reader may not see. */
export function buildTimeline(facts: TimelineFacts, nameOf: (userId: string) => string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const add = (at: Date, what: string, userId: string | null, tone: TimelineEvent["tone"] = "plain", link: TimelineEvent["link"] = null, unsettledEmailId: string | null = null) =>
    events.push({ at, what, who: userId === null ? null : nameOf(userId), tone, link, unsettledEmailId });

  const from = facts.madeFrom ? ` from ${KIND_LABELS[facts.madeFrom.kind].toLowerCase()} ${facts.madeFrom.number ?? "(draft)"}` : "";
  add(facts.createdAt, `Written${from}`, facts.createdBy);
  if (facts.heldAt) add(facts.heldAt, "Held for the owner: over the customer's credit limit", facts.heldBy, "warn");
  if (facts.submittedAt) {
    if (facts.overrideBy) add(facts.submittedAt, `Approved over the credit limit${facts.overrideReason ? `: ${facts.overrideReason}` : ""}`, facts.overrideBy, "warn");
    add(facts.submittedAt, posts(facts.kind) ? "Posted" : "Submitted", facts.submittedBy, "good");
  }
  for (const into of facts.madeInto) {
    const label = `${KIND_LABELS[into.kind]} ${into.number ?? "(draft)"}`;
    add(into.createdAt, `${KIND_LABELS[into.kind]} made from this`, null, "plain", { href: `/sales/${into.id}`, label });
  }
  for (const email of facts.emails) {
    if (email.status === "sent") add(email.at, `Emailed to ${email.to}`, email.by, "good");
    else if (email.status === "failed") add(email.at, `Email to ${email.to} failed${email.error ? `: ${email.error}` : ""}`, email.by, "warn");
    else if (email.status === "unknown") add(email.at, `Email to ${email.to}: not known whether it arrived`, email.by, "warn", null, email.id);
    else add(email.at, `Being emailed to ${email.to}`, email.by);
  }
  if (facts.cancelledAt) add(facts.cancelledAt, `Cancelled${facts.cancelReason ? `: ${facts.cancelReason}` : ""}`, facts.cancelledBy, "warn");

  // Stable: events at the same moment keep the order they were added in.
  return events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at.getTime() - b.event.at.getTime() || a.index - b.index).map(({ event }) => event);
}
