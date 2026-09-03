# Stage 2 — Financial evaluation

Purpose: decide whether the numbers make sense for this business before checking
whether they are on the right line. This is the reasonableness test a senior CPA
runs in the first ten minutes. It finds the errors Stage 1 cannot — the item that
is correctly posted, correctly reconciled, and wrong.

The platform prepares the comparison tables from the inputs (calculation layer
does the arithmetic). The model reads them and writes the anomaly and the
question.

## 2.1 Current vs prior year — every line

Produce this table for every P&L account and every balance sheet account:

| Account | Prior year | Current year | Change $ | Change % | Flag |
|---|---|---|---|---|---|

Flag rules (set by the firm, tune per client size):
- Any P&L line moving more than 25% **and** more than a materiality floor
- Any balance sheet line moving more than 50%
- Any line present last year and absent this year, or vice versa
- Any line with a sign change

For each flag, the register line is: "Line X moved from A to B. This is
consistent with / not explained by [known fact]. Question for preparer: …"

## 2.2 Ratios — the five that catch most errors

| Ratio | What a wrong value usually means |
|---|---|
| Gross margin % vs prior year and vs industry | COGS cut-off, inventory error, revenue in wrong year, purchases expensed instead of inventoried |
| Payroll ÷ revenue | Missing accruals, owner comp misclassified, contractors vs employees |
| Rent ÷ revenue | Related-party rent, prepaid, missing months |
| Interest expense ÷ average debt | Principal in P&L, missing accrual, loan not on balance sheet |
| Net income ÷ distributions | Distributions exceeding income and capital — basis problem; or income retained with no plan — accumulated earnings question for C corp |

The platform computes; the model flags a ratio only if it is outside the band
the firm set for that client type. "Looks high" is not a finding. "Gross margin
fell from 41% to 27% with no change in product mix stated" is.

## 2.3 Balance sheet sanity

| Test | Meaning |
|---|---|
| Cash ≥ 0, AR ≥ 0, inventory ≥ 0 | Negative assets are liabilities or errors |
| Accumulated depreciation ≤ cost, per asset class | Over-depreciated asset |
| Loans from owner and loans to owner not both present for the same person without reason | Usually one account posted with both signs |
| Retained earnings roll: prior closing + income − distributions/dividends ± prior-period adjustments = current closing | Any prior-period adjustment must be named and explained |
| Total assets = total liabilities + equity **on the return**, not just the TB | Drake will flag; the platform checks anyway |
| Inventory movement: opening + purchases − COGS = closing, and method (cost, lower of cost or market, FIFO/LIFO) is unchanged from prior year | Method change needs Form 3115 |

## 2.4 Cross-document consistency

| Compare | To |
|---|---|
| Gross receipts on return | 1099-K / merchant statements / sales tax returns filed |
| Wages on return | W-3 / Q4 941 / state unemployment returns |
| Contractor expense | Total of 1099-NECs issued |
| Interest expense | 1098 / lender statements |
| Payments to foreign affiliates | 5472 Part IV, 1042-S issued, India TDS certificates (Form 16A) and GST invoices — same transaction, both sides |
| Officer compensation | Payroll register and reasonable-compensation note (S corp) |
| Distributions per books | Distributions on K-1s / M-2 |
| Depreciation per books | Fixed asset register (book) and Drake 4562 (tax) |

A mismatch here is at least High. The IRS matches most of these automatically.

## 2.5 Business-model questions the reviewer would ask

Answer from the file if possible; otherwise they become preparer questions:

1. What does the business do, and does the expense mix look like that business? (A software company with $180k of "materials" needs an explanation.)
2. Who owns it, where are they, and did ownership change during the year?
3. Did the business start, stop, sell, buy, or restructure anything this year?
4. Where are the customers, employees, and inventory? (State nexus — feeds the obligation engine, not this review.)
5. Is anything paid to or received from a related party, in any country?
6. Is there a loan, lease, or guarantee from an owner or affiliate?
7. Is any account balance the same as last year to the dollar? (Stale balances — usually not reconciled.)

## 2.6 Output of Stage 2

1. Variance table with flags
2. Ratio table with band and flag
3. Register lines S2-xxx — each anomaly with the question it raises and the evidence that would close it
