# What we are building

## The problem

Today the Tax Return Center is a chat assistant. Ask it about a return and you
get a wall of text. Nothing is saved as a checklist, nothing is graded, and
nothing tracks whether an issue ever got fixed.

A senior CPA's review isn't a conversation. It's a sequence that ends in a short,
signed-off document.

## What we are building

Give it a prepared return and the books, and it produces a **one-page summary**:
a verdict, issues grouped by type, the top five to fix, and 5–10 questions for
the preparer. Each issue says what's wrong, where to look in Drake, what to
change, and why.

## How a review runs

Always in this order:

1. **Scope** — right entity, period, return type?
2. **Books** — are the underlying numbers right?
3. **Financials** — do they make sense for this business?
4. **The return** — is it correct and complete?
5. **Fixes** — what to do, and what to ask.

Books come first because most return errors are bookkeeping errors copied onto
the form accurately. Fix the form only, and the error returns next year.

## How issues are graded

Software decides the grade, not the AI. The AI says what it found; fixed rules
decide how serious it is — so the same fact gets the same grade every time.

| Grade | Meaning | Effect |
|---|---|---|
| **Critical** | Wrong figure, wrong classification, missing form, wrong entity type | Hold |
| **High** | Unsupported position, or a tie-out failing for unknown reasons | Hold until answered |
| **Medium** | Figure right, paperwork missing | Release with an owner and a date |
| **Low** | Wording, rounding, presentation | Fix if there's time |

Verdicts: **Hold**, **Release with conditions**, or **Clear**. Nothing softer.

## The safety rules

Each is enforced by software, not by asking the AI nicely.

- **No invented numbers.** Every figure must point at a document or a
  calculation the system ran. Unsourced figures are rejected. A confident,
  well-formatted wrong number looks exactly like a right one.
- **No invented citations.** There's no verified library of tax law yet, so the
  system may not cite any. It states the principle in plain English and marks it
  "needs verifying".
- **An answer isn't proof.** Type an explanation with no document attached and
  the issue stays open. It should be hard to clear something serious with a
  sentence.
- **Nothing is "fine" silently.** Every stage writes at least one line, even
  "checked, no problem" — a blank section could mean clean or skipped.
- **A person signs off.** The AI's verdict is a first pass. Approval records who,
  when, and which version they saw. If anything changes after, the approval stops
  counting.
- **Client emails stay human-written.**

## Every run is kept

Runs are never edited — corrections create a new run. Put run 2 beside run 1 and
see what closed, what's new, and whether the verdict moved. That answers the real
question: did the fix work?

## Where we are

**Done**

- The database and record-keeping behind runs, issues, questions and sign-offs
- The grading and safety rules, with 155 automated tests — including deliberate
  attempts to smuggle in a fake citation and three kinds of unsourced number,
  all refused
- The document checklist that stops a review before it starts if something
  essential is missing
- The engine that runs the five stages, one at a time so a long review survives
  being interrupted
- The one-page summary, and clicking into any issue to see the fix and where
  each figure came from
- The 5–10 questions for the preparer, and answering them — with the rule that
  a written answer alone leaves a serious issue open
- Re-running after fixes, redoing only the stages an answer could have
  affected, and putting run 2 beside run 1 to see what actually closed
- Sign-off, recording who approved, when, and exactly which version they read —
  and refusing if the register changed while they had it open
- Printing the summary for the workpaper file, and exporting the whole register
  as data

That is the review engine complete, end to end.

**Next** — a real run against a real return, which is the only thing that will
tell us whether the review itself is any good.

**Later** — Tally / QuickBooks / Zoho / Xero connections, reading Drake exports
as data rather than page images, a verified library of tax law.

**Not yet tried against a real return.** Every test so far uses a scripted
stand-in for the AI, which proves our own rules work but not that the review
itself is any good. That needs a real run on a real return, and it will cost
money and probably surface things the stand-in cannot.

## One open question

**Can we get structured exports from Drake and ProConnect, or only PDFs?**

Today the system reads returns by looking at the pages, like a person. Nothing
can independently check a figure read that way, so those are marked unverified.
Excel trial balances *are* checked properly. A structured export would turn the
tie-outs from "the AI says these agree" into "the software confirmed it" — the
single biggest improvement available to how much this can be trusted.
