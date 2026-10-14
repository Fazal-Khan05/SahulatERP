# 10 — Collections: receipts, cheques (PDC), follow-ups (COL)

Receipt methods: bank, cash, cheque. Cheque states: received → deposited → cleared; bounced from received/deposited/cleared. Only cleared cash counts as collected and releases commission.

| ID | P | T | Case | Expected |
|---|---|---|---|---|
| COL-001 | P1 | F | Record receipt, customer, cash 5,000 to Cash in hand, allocate to invoice | Receipt posted; invoice paid 5,000; cash +5,000 |
| COL-002 | P1 | F | Typing total spreads across open invoices oldest first | Allocation auto-filled; editable |
| COL-003 | P1 | N | Amount 0 | Refused |
| COL-004 | P1 | N | Allocations don't sum to amount | "Allocations must equal the receipt amount." |
| COL-005 | P1 | N | Allocation exceeds invoice outstanding | "Allocation exceeds the invoice's outstanding balance." |
| COL-006 | P1 | N | Allocation to another customer's invoice | "Receipt must reference submitted invoices for the same party." |
| COL-007 | P1 | N | Allocation to a draft invoice | Same |
| COL-008 | P2 | N | Duplicate invoice in allocations | "Duplicate allocation." |
| COL-009 | P2 | N | No allocations | Validation min 1 |
| COL-010 | P2 | E | Amount 0.0001 | Accepted |
| COL-011 | P2 | E | Exact outstanding | Invoice fully paid; balance 0 |
| COL-012 | P2 | F | Overpayment attempt | Refused (exceeds outstanding) |
| COL-013 | P1 | F | Bank receipt to chosen bank account | Bank balance up |
| COL-014 | P2 | N | Bank receipt with archived account | "{name} is archived." |
| COL-015 | P2 | N | Account id of another tenant | Not found |
| COL-016 | P1 | F | Cheque receipt with number and due date next week | Status received; NOT counted in collections; invoice not paid yet (verify design: paid on clear) |
| COL-017 | P1 | N | Cheque without number | "Enter the cheque number." |
| COL-018 | P2 | E | Cheque number 100 chars; 101 refused | Yes |
| COL-019 | P2 | F | Cheque due date = today | Allowed |
| COL-020 | P2 | F | Post-dated 90 days | Allowed; shown in cheques in hand |
| COL-021 | P1 | F | Deposit cheque choosing bank account | Status deposited; account stored |
| COL-022 | P1 | F | Clear cheque | Status cleared; bank +amount; invoice paid; commission released |
| COL-023 | P1 | N | Clear from received (skip deposit) | "Invalid cheque transition." |
| COL-024 | P1 | N | Deposit twice | "Invalid cheque transition." |
| COL-025 | P1 | F | Bounce from deposited | Status bounced; nothing collected |
| COL-026 | P1 | F | Bounce from cleared | Bank reversed; invoice unpaid again; commission release reversed; recovery recorded |
| COL-027 | P2 | N | Bounce a bounced cheque | Invalid transition |
| COL-028 | P2 | N | update_cheque on a cash receipt | "This payment is not a cheque." |
| COL-029 | P2 | N | Clear in locked period | Refused |
| COL-030 | P2 | F | Clear date custom | Journal dated accordingly |
| COL-031 | P2 | F | Cheques in hand list: received/deposited with actions | Buttons per state |
| COL-032 | P2 | F | Attention: cheques due today/overdue | Listed |
| COL-033 | P2 | F | Overview "Collections" metric | Cleared customer receipts only |
| COL-034 | P2 | D | Journal on cash receipt: Dr cash / Cr 1100 | Yes |
| COL-035 | P2 | D | Journal on cheque receipt | None until cleared (or Dr cheques-in-hand; verify design) |
| COL-036 | P2 | D | Journal on bounce after clear | Exact reversal with source linkage |
| COL-037 | P2 | D | Receivable control after receipts | Reconciled |
| COL-038 | P2 | D | Idempotent retry of create_receipt | One receipt |
| COL-039 | P2 | D | Idempotent retry of clear | One journal |
| COL-040 | P1 | F | Record receipt for walk-in customer | Invoices listed by number and typed name |
| COL-041 | P2 | F | Receipt note 1,000 chars | Saved |
| COL-042 | P2 | F | Receipt employeeId (collector) | Stored; optional |
| COL-043 | P2 | F | Receipt print | "Receipt" title, "Received from", allocations |
| COL-044 | P2 | F | Receipt numbering RCT-? per year | Sequential |
| COL-045 | P1 | S | Recovery Officer records customer receipt | Allowed |
| COL-046 | P2 | S | Salesperson records receipt | Allowed? access: create_receipt roles → verify and assert |
| COL-047 | P2 | S | Warehouse Manager records receipt | Refused |
| COL-048 | P2 | S | Branch-limited user clears cheque for other branch invoice | Refused |
| COL-049 | P1 | F | Log follow-up with note and next date | "Follow-up saved · next action YYYY-MM-DD." |
| COL-050 | P1 | N | Follow-up empty note | "Enter a follow-up note." |
| COL-051 | P2 | N | Follow-up invalid next date | Validation |
| COL-052 | P2 | F | Follow-up next date today | Attention shows due |
| COL-053 | P2 | F | Follow-up on supplier via API | "Customer not found." (parties lookup) or refused |
| COL-054 | P2 | F | Follow-up list per customer newest first | Yes |
| COL-055 | P2 | F | Follow-up dialog closes on success | Yes (follow_up auto-close) |
| COL-056 | P2 | S | Salesperson logs follow-up | Refused (Recovery Officer, Sales Manager, Owner) |
| COL-057 | P2 | F | Aged receivables after partial receipt | Buckets by due date; amounts net of paid |
| COL-058 | P2 | F | Customer statement running balance | Invoice +, receipt −, credit note − |
| COL-059 | P2 | F | Statement shows cheque only when cleared | Yes (or as pending line; assert design) |
| COL-060 | P2 | E | Receipt date before invoice date | Allowed? assert; no negative aging crash |
| COL-061 | P2 | E | Receipt in future date | Allowed or refused consistently |
| COL-062 | P2 | F | Receipt against invoice fully returned | Outstanding 0 → refused |
| COL-063 | P2 | F | Receipt against invoice partially returned | Up to remaining |
| COL-064 | P2 | F | Credit note then receipt larger than remaining | Refused |
| COL-065 | P2 | F | Receipt dialog on phone | Bottom sheet; allocations table scroll |
| COL-066 | P2 | U | Method radio/select shows cheque fields only for cheque | Yes |
| COL-067 | P2 | U | Account select lists bank and cash accounts, not archived | Yes |
| COL-068 | P2 | U | Amount placeholder | Empty with placeholder |
| COL-069 | P2 | F | Collections hidden module | Receipts still visible in Accounting; attention cheque items gone |
| COL-070 | P2 | F | Cheque register also visible in Cash & bank | Same data |
| COL-071 | P2 | D | Bounce after commission paid in payroll | Recovery recorded on commission; next payroll deducts |
| COL-072 | P2 | D | Clear after bounce? | Invalid (bounced is terminal) |
| COL-073 | P2 | D | Two cheques for the same invoice | Both allowed up to outstanding |
| COL-074 | P2 | D | Commission release proportional to cash | 50% cash → 50% released |
| COL-075 | P2 | F | Receipts list filters by method/status | Yes |
| COL-076 | P2 | F | Search by cheque number | Found |
| COL-077 | P2 | E | Cheque number with spaces/dashes | Saved |
| COL-078 | P2 | E | Note with emoji | Saved |
| COL-079 | P2 | F | Deposit without account id | Allowed? API accepts optional; UI requires select → assert |
| COL-080 | P2 | F | Deposit into cash account type | Refused or allowed; assert design |
| COL-081 | P2 | S | Auditor views receipts | Read-only |
| COL-082 | P2 | F | Receipt against invoice in locked period but receipt dated open period | Allowed |
| COL-083 | P2 | F | Receipt allocation to 10 invoices | Each updated |
| COL-084 | P2 | X | 5,000 receipts | List/aging < 2 s |
| COL-085 | P2 | F | Attention "Cheques due" count badge on bell | Matches |
| COL-086 | P2 | F | Follow-up actor name recorded | Signed-in member |
| COL-087 | P2 | F | Follow-up on archived customer | Allowed? assert |
| COL-088 | P2 | D | Receipt journal memo contains receipt number | Yes |
| COL-089 | P2 | D | Bank account code used in journal = account's ledger code | Yes |
| COL-090 | P2 | F | Receipt for supplier via Collections | Not offered (Purchasing → Supplier payments) |
| COL-091 | P2 | F | Clear cheque dated earlier than deposit | Allowed; order by date in statement |
| COL-092 | P2 | F | Bulk: 20 cheques cleared one by one | Each independent |
| COL-093 | P2 | U | Status badges: received amber, deposited info, cleared green, bounced red | Yes |
| COL-094 | P2 | U | Receipt row actions by state | Deposit/Cleared/Bounced only valid ones |
| COL-095 | P2 | F | Print cheque receipt before clearing | Shows status received |
| COL-096 | P2 | F | Recovery Officer sees only sales documents and receipts | Yes |
| COL-097 | P2 | F | Customer with no open invoices in receipt dialog | "No open invoices" state; cannot save |
| COL-098 | P2 | D | Outstanding = total − paid − returned always | Spot-check 5 invoices |
| COL-099 | P2 | D | Trial balance after bounce sequence | Balanced |
| COL-100 | P1 | F | End to end: invoice 10,000 → cash 4,000 → cheque 6,000 deposit → clear → bounce → re-receive cash; statement and commission correct | All pass |

Covered by automation: `cash-bank-reports.spec.ts` (receipts, cheques), `documents.spec.ts`, unit `workflows.test.ts` (release/bounce).
