# Preparer question generator

After the register is built, produce 5–10 questions for the preparer. The goal
is to close High findings without a review meeting, and to stop the platform
flagging items that have a simple explanation.

## Rules

1. **One question per unresolved High or Critical finding first.** Then Medium. Never ask about Low.
2. **Each question is answerable with a fact, a document, or a yes/no** — not "please explain". "Was the $18,000 paid to Rajesh Mehta on 14 March a loan repayment or a distribution? Attach the loan agreement if a loan." Not "Please clarify the owner payments."
3. **Reference the finding ID and the exact figure.** The preparer must not have to hunt.
4. **State what happens on each answer.** "If a loan: reclassify to loan payable, no K-1 effect. If a distribution: K-1 box 19 and M-2 change." The preparer then sees the consequence and answers carefully.
5. **Group by owner.** Questions the preparer can answer from the file come first; questions needing the client are marked `client` so the partner can raise them together in one email.
6. **Cap at 10.** If more than 10 High/Critical findings exist, the return is on hold anyway — the register is the communication, and the first 10 questions cover the ones that block the most lines.
7. **Never ask a question the file already answers.** Before generating, re-read the preparer's notes and open-item list. Asking again wastes senior time and trains the team to ignore the list.
8. **No leading questions and no suggested answers that could be adopted without evidence.** "Is this a distribution?" invites yes. "What is this payment, and what document shows it?" does not.

## Question format

```
Q-n  [Finding S3-004]  [Owner: preparer | client]
     Question: …
     Figure:   $… on [form/line] from [GL account]
     If A:     …   →   change …
     If B:     …   →   change …
     Evidence needed: …
```

## Examples

```
Q-1  [Finding S1-007]  [Owner: preparer]
     Question: The December bank reconciliation shows $250 of bank charges not in the ledger.
               Has this been posted after the TB export, or is it still open?
     Figure:   $250 difference, Schedule L line 1, GL 1010 Operating Account
     If posted: re-export TB, re-enter, confirm L line 1 = $41,930.
     If open:   post Dr 6120 Bank charges / Cr 1010 Cash $250, then as above.
     Evidence needed: updated bank rec report.

Q-2  [Finding S3-002]  [Owner: client]
     Question: Did Priya Holdings Pte Ltd (Singapore) own 25% or more of the company at any
               time in the year? The cap table shows 24.9% at 1 Jan and 30% at 30 Jun.
     Figure:   Ownership; affects Schedule K question 7 and whether Form 5472 is required
     If yes:   5472 required — one per related party with transactions; hold return.
     If no:    document the ownership history in the file; no 5472.
     Evidence needed: signed cap table with dates, or share register.

Q-3  [Finding S2-003]  [Owner: preparer]
     Question: Gross margin fell from 41% to 27%. Was there a change in product mix, pricing,
               or a large year-end purchase left in COGS rather than inventory?
     Figure:   COGS $612,400 vs revenue $838,900; prior year 59% COGS ratio
     If year-end purchase: move to inventory, closing inventory per count sheet.
     If mix/pricing:       note the reason in the file; no return change.
     Evidence needed: inventory count at year end, or management explanation.
```

## Answer handling

When the preparer answers, the platform:
- Attaches the answer and evidence to the finding
- Re-runs only the affected checks (not the whole review)
- Updates the finding status: `closed` (evidence supports), `changed` (fix applied, re-verify), `escalated` (answer needs reviewer judgement), `client` (waiting on client)
- Regenerates the verdict

A finding closed by an answer with no attached evidence stays `open` with a note "answered, evidence pending". Verbal explanations do not close High findings.
