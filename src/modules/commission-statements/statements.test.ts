import { describe, it } from "vitest";

// Step 39's database tests, against drizzle/0028_commission_statements.sql and Step 38's ledger.
// The shape is written before Step 38 is on main; each case is built on Step 38's fixtures
// (src/modules/commission-ledger/ledger.test.ts) once it is.

describe("a commission statement equals the movements for the period", () => {
  it.todo("an invoice, a cheque that clears, a cheque that bounces after clearing, a return and a payment that takes back what was owed: the period's columns equal the movements dated in it, by type");
  it.todo("what came before the period plus the period equals the person's accruals as they stand, when the period ends today");
  it.todo("two periods back to back: the first's end is the second's beginning");
  it.todo("everyone's statements together: earned less paid equals the Commission payable account in the books");
  it.todo("an invoice of several lines is one line on the statement; a manager's share names the team member and the team rate");
});

describe("who reads whose statement", () => {
  it.todo("a salesperson reads their own, and is refused another's (insufficient_privilege), even a team mate's");
  it.todo("a manager reads their own and everyone below them in the hierarchy, at any depth, and is refused anyone else's");
  it.todo("a manager who is moved stops seeing the old team's statements");
  it.todo("the owner, an accountant and the auditor read everyone's; an accountant who works in some branches only reads their own");
  it.todo("a member of another company is refused; the summary lists only whom the reader may read");
  it.todo("the statement shows the receipt and credit note numbers to a salesperson, who cannot read receipts themself");
});

describe("the functions themselves", () => {
  it.todo("a period the wrong way round, or with an infinite date, is refused");
  it.todo("every new function has search_path pg_catalog, pg_temp and is not executable by PUBLIC");
});
