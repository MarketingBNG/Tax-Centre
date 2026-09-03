# Stage 1 — Books and bookkeeping review

Purpose: confirm the trial balance the return is built on is complete, reconciled,
and classified the way US GAAP (or the tax basis the client has elected) requires.
A return built on bad books is a bad return with correct arithmetic.

Work top to bottom. Each step ends with a register line — exception or "agreed".

## 1.1 Trial balance integrity

| Check | How | Plain-English why |
|---|---|---|
| TB balances | Debits = credits, and total agrees to the GL export | If it doesn't, the ledger was edited after export |
| Opening equity = prior-year closing equity per return | Compare TB opening retained earnings / partners' capital to last year's Schedule L / M-2 ending | The IRS compares this year's beginning balance to last year's ending. A gap means a prior-period entry was posted or the books were reopened |
| No suspense, "Ask My Accountant", uncategorised, or opening-balance-equity balances | Every such account must be zero at year end | These are undecided transactions; they cannot be classified on a return |
| Period cut-off | Last invoices, last bills, last payroll fall inside the year; nothing dated after year end is in the year | Accrual clients: December bills paid in January belong in December; cash clients: the reverse |
| Basis of accounting matches the return | Cash vs accrual per books = box checked on the return; consistent with prior year unless a method change was filed | Changing method without Form 3115 is an unapproved accounting-method change |

## 1.2 Cash and bank

| Check | Evidence |
|---|---|
| Every bank and credit card account has a year-end reconciliation with zero unexplained difference | Bank rec report + statement |
| Reconciling items are real — outstanding cheques still outstanding, deposits in transit cleared in January | January statement |
| Negative cash balance — never acceptable on Schedule L | If the book shows negative cash, it is either an overdraft (reclassify to liability) or a posting error |
| Undeposited funds at year end cleared | Zero or supported |
| Foreign-currency accounts translated at year-end rate (balance sheet) and average/transaction rate (P&L) | Rate source noted; FX gain/loss posted to a separate account |

## 1.3 Receivables and revenue

| Check | Why |
|---|---|
| AR aging agrees to TB; nothing over 120 days without a reason | Old AR is either bad debt or a booking error — both change income |
| Bad debt written off only when actually uncollectable (tax) even if reserved (GAAP) | GAAP allowance is not deductible; tax needs a specific write-off — this creates an M-1 item |
| Revenue recognised in the right year | Accrual: when earned. Cash: when received. Deferred revenue / customer deposits sit on the balance sheet |
| Intercompany / related-party sales identified and separately coded | These feed 5472, K-1 disclosures, and transfer pricing |
| Sales tax collected is a liability, not revenue | Grossed-up revenue overstates income and understates the liability |
| Refunds and credit notes netted against revenue, not expensed | Presentation affects gross receipts thresholds |

## 1.4 Payables, accruals and liabilities

| Check | Why |
|---|---|
| AP aging agrees to TB; year-end bills for the year are recorded (accrual) | Missing accruals overstate income |
| Payroll liabilities agree to Q4 941 and state returns | Fastest IRS mismatch on record |
| Loans: closing balance agrees to lender statement; interest expense agrees to statement or amortisation table; principal never in P&L | Principal in P&L is the most common junior error on owner-funded companies |
| Owner / shareholder / partner loans: documented, interest charged where required, direction (to or from owner) correct | Undocumented "loans" to owners are distributions; from owners may be capital — both change equity and disclosures |
| Deferred revenue, customer deposits, gift cards classified as liabilities | See 1.3 |
| Accrued bonuses / vacation: GAAP accrues; tax deducts only if paid within 2½ months after year end (accrual method) | M-1 item; `authority: verify` |
| Credit card balances agree to statements and are liabilities, not negative cash | Presentation |

## 1.5 Fixed assets, depreciation, intangibles

| Check | Why |
|---|---|
| Fixed asset register agrees to TB cost and accumulated depreciation | Register is the source; TB is the copy |
| Additions: every item above the client's capitalisation policy is capitalised; items below are expensed consistently (de minimis safe harbour election attached if used) | Policy and election drive whether $2,400 laptops are expense or asset |
| Repairs vs improvements: repairs expensed; betterments, restorations, adaptations capitalised | Highest-value classification call on Schedule L; `authority: verify` |
| Disposals removed from register and gain/loss computed by calculation layer | Assets sold but still depreciating |
| Book depreciation (GAAP straight-line) vs tax depreciation (MACRS / bonus / §179) kept separately | Difference is a scheduled M-1 line; Drake computes tax; books should carry book |
| Software, website, formation costs, trademarks classified as intangibles and amortised per their rule | Start-up and organisation costs have specific tax treatment; `authority: verify` |
| Leased assets: operating vs finance lease per GAAP (ASC 842) noted; tax follows lease terms | GAAP-basis clients will have right-of-use assets that have no tax basis — M-1 |

## 1.6 Expense classification — the GAAP sweep

Read the GL for these accounts line by line. For each, the platform flags the
transaction, states the proposed reclassification, and gives the reason. It does
not reclassify; the preparer does.

| Account | Look for | Reclassify to | Reason (plain English) |
|---|---|---|---|
| Meals | 100% booked | Split: business meals (50% deductible), entertainment (0%), employee meals / de minimis (check rule) | Tax limits deduction; books need the full amount, return needs the split — M-1 |
| Travel | Personal travel, family, first-class upgrades without policy | Owner draw / distribution | Not ordinary and necessary |
| Auto | Personal vehicle, no mileage log, 100% business claimed | Owner draw for personal portion; note if log missing | IRS disallows without substantiation |
| Office / supplies | Equipment above cap policy | Fixed assets | See 1.5 |
| Professional fees | Formation, capital raising, acquisition due diligence | Organisation costs / capitalised transaction costs | Not currently deductible in full; `authority: verify` |
| Rent | Related-party rent above market; deposits expensed | Deposit → asset; excess → distribution / TP adjustment | Related-party pricing is a 5472 / TP item |
| Insurance | Multi-year policies expensed in full; owner's personal life insurance | Prepaid; non-deductible | Timing; personal |
| Charitable contributions | Booked as expense | Separately stated (K-1 / Schedule K / 1120 line) | Deducted differently by entity type |
| Fines, penalties, political | Booked as expense | Non-deductible — M-1 | Statutory disallowance |
| Interest | Principal included; interest to related parties; interest on owner personal debt | Loan principal → liability; related-party → 5472 / §163(j) check; personal → draw | Classification |
| Payroll / contractors | Owners of S-corps paid as contractors; contractors with no W-9; 1099 totals ≠ GL | Officer compensation; 1099 filing obligation | Reasonable compensation; information-return penalties |
| Guaranteed payments (1065) | Partner salary coded as wages or as distributions | Guaranteed payments | Partners cannot be W-2 employees of their own partnership |
| Owner distributions | Coded as expense (salary, "management fee", "consulting") | Equity | Never P&L for partnerships / sole owners; for corporations, a dividend, not a deduction |
| Reimbursements | Owner paid personal card, company reimbursed — booked as expense to the owner name | Underlying expense category | Classification and substantiation |
| Foreign payments | Payments to foreign parent / affiliate / contractor for services, royalties, interest, management fees | Flag for 1042 withholding, 5472, TP, and India-side TDS/GST symmetry | Cross-border payments trigger obligations on both sides |
| Gifts | Above per-person limit | Non-deductible portion — M-1 | Statutory limit; `authority: verify` |
| Software subscriptions | Multi-year prepaid | Prepaid | Timing |
| Bank / merchant fees | Stripe / PayPal fees netted out of revenue | Gross up revenue, expense fees | Gross receipts presentation |
| Taxes | Federal income tax and state income tax booked as expense | Federal → non-deductible (M-1); state → deductible for federal, add back for state | Classification |
| Amortisation / depreciation | Booked at tax amounts | Book amounts; tax difference on M-1 | Two sets of numbers, one place to reconcile |

## 1.7 Equity

| Entity | Check |
|---|---|
| Partnership / LLC | Capital accounts per partner: opening + contributions + share of income − distributions − share of loss = closing. Tax-basis capital required on K-1 — confirm which basis the books carry |
| C corporation | Common stock and APIC agree to cap table; retained earnings rolls; dividends recorded as equity, not expense; treasury stock |
| S corporation | AAA and shareholder basis tracked; distributions pro-rata to ownership; no second class of stock created by unequal distributions |
| Single-member LLC (disregarded, foreign-owned) | Owner contributions and distributions tracked separately — every one is a 5472 reportable transaction |

## 1.8 Output of Stage 1

1. Reconciled trial balance with proposed adjusting entries (each entry: debit, credit, amount from source, reason, evidence). Amounts come from the source document — never estimated.
2. Register lines S1-xxx.
3. List of GL accounts not sampled, so the reviewer knows the coverage.
