# Drake fix guide — plain English for the operator

Every finding ends with a fix written for a novice Drake operator. Follow this
template and these rules.

## The fix template

```
FIX:
  Where:   [form / schedule / line the error shows on]  →  [Drake data-entry screen, if known]
  Change:  [what to enter, remove, or move — with the correct amount and its source document]
  Then:    [what to re-check after saving — the line that must now agree]
  Why:     [one line]
```

Example:

```
FIX:
  Where:   Schedule L, line 1 (Cash), end of year  →  Drake balance sheet screen
  Change:  Replace $42,180 with $41,930 per the December bank reconciliation. First post the
           adjusting entry in the books (Dr Bank charges $250 / Cr Cash $250) so the TB agrees.
  Then:    Re-run the return; confirm total assets still equal total liabilities + equity and
           that page 1 line 22 moved by the $250 expense.
  Why:     The return must agree to the reconciled books; IRS compares L to next year's opening.
```

## Rules for writing fixes

1. **Fix the books first, then the return.** If the error is in the trial balance, the fix says "post this adjusting entry, re-import / re-enter the TB, then confirm the line". Never instruct the operator to override a Drake figure so it disagrees with the books.
2. **Never override a Drake computation.** Depreciation, tax, penalties, limitations, K-1 allocations are computed by Drake from inputs. The fix changes the input (asset date, method, ownership %, election), not the result. If Drake's result still looks wrong after the input is right, the finding says "escalate to reviewer — computation disagrees with expected".
3. **One amount, one source.** Every amount in a fix names the document it came from. "Per bank statement dated …", "per fixed asset register line 14", "per operating agreement §4.2".
4. **Say where in Drake only if certain.** Drake screen codes change by return type and year. Where the platform's Drake reference map (maintained by the team, not by the model) has the screen, quote it. Otherwise describe the location by form and line — the operator can find it with Drake's form view. A wrong screen code sends a novice to the wrong place; a missing one costs a minute.
5. **Elections are attachments, not tick boxes.** If the fix requires an election (de minimis safe harbour, bonus opt-out, §754, §179, method change), the fix says: "attach the election statement in Drake's elections screen and confirm it prints with the return".
6. **Re-check instruction is mandatory.** Every fix ends with the line that must agree afterwards, so the operator knows they are done.
7. **Client-input items are not fixes.** If the correct figure needs a fact from the client, the fix says "hold — needs client answer to Q-n" and the question goes to the preparer list.

## Common fixes by category

| Finding type | Typical fix |
|---|---|
| Balance sheet does not balance | Fix the TB (usually a missing accrual, an equity posting, or a suspense balance); re-enter; never plug |
| Opening balance ≠ prior year closing | Identify the prior-period entry; either reverse it (if error) or show as "other adjustment" on M-2 with a statement |
| Book/tax depreciation mismatch on M-1 | Confirm asset register (book) is in the books and Drake 4562 (tax) has correct dates, methods, business-use %; M-1 difference should then equal register book depreciation − Drake tax depreciation |
| Meals at 100% | Split the GL account; enter the deductible portion; Drake adds back the rest on M-1 |
| Owner distribution in P&L | Reclassify to equity in books; distribution appears on M-2 / K-1 box 19 / 1120 M-2 |
| Loan principal in interest expense | Reclassify to loan liability; interest expense per lender statement |
| Federal tax in expense | Leave in books; confirm Drake adds back on M-1 line 2 |
| K-1 percentages wrong | Fix on the partner/shareholder screen; confirm sum = 100% and all K-1 boxes re-total to Schedule K |
| Missing 5472 | Add the related party on the 5472 screen (one per party); populate Part IV from the ledger category totals; confirm it prints with the return |
| Missing 8833 with treaty claim | Add the treaty statement; cite the article from the treaty text in the corpus; confirm the reduced rate now flows |
| State return missing | Add the state; enter apportionment from the books; confirm nexus per obligation engine |
| Schedule B / Schedule K question defaulted | Answer each question from the facts; attach the form each "yes" requires |
| Guaranteed payments as wages | Remove from payroll expense; enter as guaranteed payments on the partner screen; confirm K-1 box 4 |
| Sales tax in revenue | Reclassify to liability in books; re-enter gross receipts |
| Prepaid expensed | Reclassify to prepaid in books; expense the current-year portion only |
