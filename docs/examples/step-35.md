# Step 35 worked example: a month's bank statement matched and reconciled

**Checked by Claude, not by an accountant.** The statement is made up
(`docs/examples/step-35-statement.csv`, an HBL-style file). Every figure below was worked out here,
then a second time by an independent worker given only the books, the statement and the rules,
not these answers or the software; both agree on every figure, and so does the test against the
database (`src/modules/bank-reconciliation/reconciliation.test.ts`).

## The books and the bank, November 2026

Money into the bank is positive, money out negative. Nothing was in the account before November,
and the statement's opening balance is nil.

| Books | Day | Amount | Statement | Day | Amount | Matched by |
| --- | --- | ---: | --- | --- | ---: | --- |
| JV-2627-00001 | 02 Nov | 50,000.00 | a. Cash deposit | 02 Nov | 50,000.00 | amount and day |
| JV-2627-00002 | 03 Nov | -20,000.00 | b. Clearing cheque 000412 | 05 Nov | -20,000.00 | amount and day |
| JV-2627-00003 | 05 Nov | 15,000.00 | c. IBFT JV-2627-00003 Corner Shop | 06 Nov | 15,000.00 | named in the statement |
| JV-2627-00004 | 08 Nov | 7,500.00 | d. Online transfer received | 09 Nov | 7,500.00 | amount and day |
| JV-2627-00005 | 10 Nov | -30,000.00 | e. Standing instruction rent | 10 Nov | -30,000.00 | amount and day |
| JV-2627-00006 | 12 Nov | 12,345.67 | f. IBFT received | 13 Nov | 12,345.67 | amount and day |
| JV-2627-00007 | 15 Nov | -5,000.00 | g. FBR PSID payment | 17 Nov | -5,000.00 | amount and day |
| JV-2627-00008 | 20 Nov | 100,000.00 | h. Loan disbursement | 20 Nov | 100,000.00 | amount and day |
| JV-2627-00009 | 25 Nov | -80,000.00 | i. Clearing cheque 000415 | 26 Nov | -80,000.00 | amount and day |
| JV-2627-00010 | 28 Nov | -3,000.00 | (not on the statement: a cheque not yet presented) | | | |
| | | | j. Bank charges and FED | 29 Nov | -250.00 | (not in the books) |

**9 of the statement's 10 lines (90%) match automatically**: line c by the document number the
customer wrote, the other eight because each is alone in its amount within three days before to
ten days after its entry. Every amount is there once on each side, so none is a guess.

## Reconciled on 30 November

The bank charges are put in the books on 30 November (JV-2627-00011, -250.00) and matched with
line j by hand.

| | |
| --- | ---: |
| Balance per bank (49,845.67 to line i, less 250.00) | 49,595.67 |
| Balance per books (49,845.67, less 3,000.00, less 250.00) | 46,595.67 |
| Less: entries the bank has not shown yet (JV-2627-00010) | -3,000.00 |
| Add: lines on the statement not in the books yet | 0.00 |
| **Books, reconciled** (46,595.67 + 3,000.00 + 0.00) | **49,595.67** |
| **Difference** | **0.00** |

The books reconciled equal the bank: the step's acceptance.

## The same on 29 November

The charges' entry of the 30th is not yet in the books' balance, and its match crosses the day, so
line j counts as not in the books.

| | |
| --- | ---: |
| Balance per bank | 49,595.67 |
| Balance per books (entries 1 to 10) | 46,845.67 |
| Less: entries the bank has not shown yet | -3,000.00 |
| Add: lines on the statement not in the books yet (line j) | -250.00 |
| **Books, reconciled** | **49,595.67** |
| **Difference** | **0.00** |

## The second working

The independent worker, given the ten entries, the ten statement lines and the two matching rules
alone, found the same matches (line c by its document number, the other eight by amount and day,
line j and JV-2627-00010 left), 90% matched automatically, and every figure in both tables above.
