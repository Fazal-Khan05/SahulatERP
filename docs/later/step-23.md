# Step 23: print, PDF and email of sales documents; the document timeline

Track A. Built on 2026-11-14 by the Finisher session.

## What was built

- **A printed page for every numbered sales document**: quotation, sales order, delivery note
  and invoice, at `/print/sales/<id>`, on the company's letterhead with its logo. An invoice of a
  company registered for sales tax is a "Sales tax invoice" and shows each line's value excluding
  tax, rate and sales tax; further and extra tax get columns only when a line has them. Documents
  with prices print the total in words, in lakh and crore ("Rupees Twelve Lakh Forty-Five
  Thousand Six Hundred Only"). A delivery note has no prices and has two signature lines. A
  cancelled document prints marked as cancelled, with the reason. A draft cannot be printed.
- **A PDF of the same**, made on the server with `@react-pdf/renderer`, at
  `/print/sales/<id>/pdf`. The printed page and the PDF are drawn from one view
  (`src/modules/sales-print/view.ts`), so they say the same things.
- **Email to the customer, built up to the send**: a form on the document's page (to, subject,
  message; the customer's contact email and a short message filled in), the PDF attached, the
  intent written before the email service is called and the outcome after, in the new table
  `sales_document_emails` (migration `0020_sales_document_emails`). An email whose outcome is
  not known is asked about before the document is sent again, and a member can settle it ("It
  arrived" / "It did not arrive"). **No email service is chosen yet, so nothing is sent**: the
  page says "Email is not set up yet" and the form is not shown. See "Decided by the founder".
- **The document's timeline** ("What happened") on its page: written (and from what), held for
  the owner, approved over the credit limit, submitted or posted, documents made from it,
  emails, cancelled; each with when and by whom.
- A permission `sales.email` (owner, accountant, sales manager, salesperson) in
  `src/tracks/selling.ts`; the database policy names the same four roles.

## Review of the migration

An independent reviewer attacked `0020_sales_document_emails` as arbitrary SQL from the app's
role. Nothing crossed a company, a branch or a salesperson's documents. Fixed in the migration
itself:

- an email's start time could be set by hand, and one dated in the future would have looked
  "being sent" for ever and stopped the document being emailed again: it must now be `now()`;
- the time an outcome was written could be set by hand: it must now be `now()`;
- nothing on the row said who wrote the outcome: `finished_by` is added and must be the member
  writing it;
- a subject could hold a line break, and an address a comma, semicolon or odd space: refused, by
  the database and by the form.

Each has a test in `src/modules/sales-email/email.test.ts`.

## Decided by the founder

- 2026-11-14: **PDF library `@react-pdf/renderer`** may be added (offered: it, browser-only with
  no library, or pdf-lib).
- 2026-11-14: **The email service is decided later.** Everything up to the send is built.
  To finish: choose a service (Resend was recommended: free up to 3,000 emails a month, called
  directly with no library), verify a sending domain with it (DNS records), put its key in the
  environment yourself (never in the chat or Git), and write its `MailSender` in
  `src/modules/sales-email/sender.ts`: `send` passing the email's own id as the idempotency key,
  and `lookup` asking the service what became of an email by that key. Then the acceptance test
  "Email arrives with the PDF" can be run for real. Until then it is proved only with a stand-in
  for the service (`src/modules/sales-email/email.test.ts`).

## Later

- **The company has no address.** The letterhead shows the logo, the name and the NTN/STRN, but
  there is nowhere to keep the company's address, phone or email. Adding them is a shared change
  (the `settings` or `company_setup` table).
- **No bank details or terms at the bottom of an invoice.** Many invoices here print the bank
  account to pay into and the payment terms. Needs a place to keep them (shared settings).
- **A WebP logo is left off the PDF** (the PDF library draws PNG and JPEG only); it still shows
  on the printed page. Ask for a PNG or JPEG logo, or convert on upload.
- **The PDF uses the built-in Helvetica font**, which has Latin letters only: a description in
  Urdu would print as blanks in the PDF (the printed page is fine). Embedding a font with Urdu
  letters is needed before Urdu documents.
- **The timeline is a card at the bottom of the page**, not a column on the right as UI principle
  5 describes. Moving it to the right means changing the layout of every sales screen; do it when
  the document screens are next reworked.
- **Members are shown by email** in the timeline (members have no names yet). A salesperson sees
  their own name, the sales team's and "Another member" for anyone else (an accountant who
  posted an invoice, say); an owner or auditor sees everyone.
- **Printing is not recorded.** Reading a document is not a command, so printing or downloading
  its PDF writes no audit row and does not appear in the timeline.
- **The message of an email is not kept**, only its address, subject and outcome. The PDF is not
  kept either: it is made again from the document, which never changes once numbered.
- **A member may mark an email "sent" or "failed" without any service being asked.** It is their
  own company's log; the row's `finished_by` and the audit row say who did it.
- **`src/lib/` would be the natural home of the email sender**, since other tracks will email
  statements (Steps 33 and 39). It lives in `src/modules/sales-email/` because `src/lib/` is
  shared; Steps 33 and 39 may import `MailSender` and `mailSenderFromEnvironment` from there, or
  move them to `src/lib/` as a shared change.
- **Credit notes** (Step 21) are not printed yet: `printTitle` and the print view know the four
  kinds that exist. Step 21 adds the fifth.
- **`npm run db:local` makes databases owned by `supabase_admin`**, so a new migration cannot be
  applied to them as `postgres` (drizzle-kit exits 1 with no message). Fixed by hand for
  `app_finisher` with `alter database app_finisher owner to postgres`; reported to the
  coordinator for the script.

## For the other tracks

- `sales_document_emails` (`document_id`, `status`: sending, sent, failed, unknown;
  `finished_at`) may be read by anyone who can see the document. Its columns will not be renamed.
- `src/modules/sales-print/rules.ts` `amountInWords(amount, currency)` gives a rupee amount in
  words; `pdf.tsx` and `view.ts` show how a printed document and its PDF are made from one view.
  Customer statements (Step 33) and commission statements (Step 39) can follow the same pattern.
- `src/modules/sales-email/rules.ts` `MailSender` is the interface an email service is written
  to; `commands.ts` shows intent, outcome and settling an unknown outcome.
