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

Software decides the grade, not the AI. The AI says *what kind* of problem it
found; fixed rules decide how serious that is.

One honest caveat, from testing against the real model: the rules are perfectly
consistent, but the AI still chooses which kind of problem it is reporting, and
two runs can classify the same fact differently — we saw one model call an open
suspense account a missing-paperwork issue and another call it a
misclassification, which are different grades. So this removes most of the
variation, not all of it. That is a good argument for the human sign-off being
where it is.

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
- The grading and safety rules, with 235 automated tests — including deliberate
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

**Tried against the real AI, once.** A small trial balance with four
deliberately planted problems, run through the real books stage. It found all
four, used the calculator rather than doing sums in its head, wrote a usable
fix for each, and recorded plainly which sections it had *not* tested. Every
safety rule held. Cost: about 11 cents.

Two things that run taught us:

- The stronger model is worth it. On the cheapest one, two of the four problems
  were missed — including an owner's drawings booked as an expense, which is
  exactly the kind of error this is for. The platform defaults to the stronger
  one.
- It is honest about coverage. Nine of the thirteen lines it wrote were "this
  was not tested, and here is why" — which is the point of the rule that
  nothing may be silently fine.

**Walked end to end.** The full sequence a reviewer actually goes through is now
tested in one go: set up an engagement, run all five stages, answer the
questions, watch the verdict move, sign off, change something and watch the
sign-off lapse, then re-run and compare. It found one real gap while doing so —
sections the engine skipped as *not needed for this client* were shown on the
progress bar but never written onto the summary itself, so the printed page was
silent about them. Same for a document you chose to proceed without. Both now
appear as "not checked, and here's why", which was the whole point of that rule.

## Against the original brief

Akshay's build guidance lists 24 items in four phases. Twelve are done — the
whole review engine and summary phase, items 9 to 12 and 17 to 22. All five
guardrails hold, and the rule that client emails stay human-written is kept by
there being nowhere in the system to draft one.

Four more have since been finished:

- **The information-return grid** now covers 5471 and its Schedule M, 5472 and
  the pro-forma 1120, 8858, 8865, 8621, 3520, 3520-A, 926, 8833, FBAR, 8938,
  state returns and the Indian 3CEB — one row per fact, so a partner can check
  it against the instructions without reading code. Where a threshold is not
  visible to the platform, it raises the form and says what to test rather than
  deciding.
- **India symmetry** now has to answer for *each* cross-border fact, not just
  say something. The stage is told which facts to mirror from the same list the
  verdict checks, so what the AI is asked for and what the platform enforces
  cannot drift apart. "Nothing is due in India for this, and here is why"
  answers a fact; silence does not, and the summary will not settle while a
  fact is unanswered.
- **Confidence per figure.** Each number now carries what its source is worth:
  computed is certain, quoted from readable text nearly so, read off a page
  image not checkable at all. Where a serious finding rests on an unreadable
  figure, it goes to a queue and a person confirms it against the page by name.
  The record still says the figure was read visually — that is why it needed
  confirming.
- **The citation library.** There are now tables for dated authority the firm
  loads — form instructions, IRS publications, its own SOPs, statutory text it
  holds the rights to — and the AI can only cite what it retrieved from them,
  quoting the words it relies on. The platform checks both halves: that the
  citation is in the library and was in force for that year, and that the quoted
  words are really in the passage. A real section attached to words it does not
  contain is refused too. Nothing is loaded yet, so nothing grounds — which is
  the correct answer, not a broken one. Loading it is a firm decision about
  licensed content, not a build task.

One is still part-done: **the thirty-return test set**. There is now a real
harness with nine synthetic returns, each carrying known defects, plus a clean
return — a reviewer that finds three problems where there are none is as wrong
as one that misses three — and two bait returns that invite an invented citation
and a made-up figure. It scores what was found and refuses vague credit: a
finding only counts if it names the account or form. The set is nine, not
thirty, and all of it is synthetic, so it catches regressions rather than
proving readiness. The rest have to be real returns with known answers.

The first real-model run against it is worth reporting honestly: on the
partnership return with three planted book problems, the AI found one of the
three before the spending cap stopped the run. Every safety rule held — 19
figures, all sourced, no citation stored as authority — but one in three is not
a review. That is what a test set is for, and it is the reason to have built it
before pointing this at a client file rather than after.

Two are not started, and both are blocked on something outside the code: the
four books connectors with their chart-of-accounts mapping (needs app
credentials for QuickBooks, Zoho and Xero), and the structured Drake and
ProConnect parsers (needs one real export file to read).

## What is left

**Before anyone uses it — three things, and they all need a decision from you.**

1. **It has never run on the live site.** Everything so far ran locally, or in a
   database transaction that was thrown away afterwards. The new tables have to
   be created for real before a single review can be started. That is a one-time
   thing, and it is your call whether they go into the live database or a
   separate one first.
2. **Nobody has clicked through it.** The screens are built and tested, but no
   person has done the full loop by hand — start a review, watch it run, read
   the summary, answer a question, sign off, print. That is where the awkward
   parts show up.
3. **One real client return.** A test file is small and tidy. A real Drake PDF
   is neither, and figures read off a page are the weakest input the system has.

**Two need something from outside the code**

- **Books connectors** need app credentials — a QuickBooks, Zoho and Xero
  developer app each, and confirmation that the firm's existing Tally connector
  is the one to reuse rather than building a second.
- **Structured return parsers** need one real Drake export and one ProConnect
  export to read. The format cannot be guessed, and guessing it would produce a
  parser that works on nothing.

**After that, in rough order of value**

- **Structured Drake / ProConnect exports** instead of page images — the single
  biggest gain available, and the open question below.
- **Books connections** (Tally, QuickBooks, Zoho, Xero) so the trial balance is
  pulled rather than uploaded.
- **A verified library of tax law**, so the system can cite authority instead of
  stating the principle and marking it "needs verifying".
- **A wider test set** — around thirty returns with known answers, to measure
  whether it is getting better rather than just different.
- **Prior-year comparison** — this year against last, to catch errors that
  repeat.

Client-facing anything stays off the list deliberately. Emails to clients are
written by a person.

## One open question

**Can we get structured exports from Drake and ProConnect, or only PDFs?**

Today the system reads returns by looking at the pages, like a person. Nothing
can independently check a figure read that way, so those are marked unverified.
Excel trial balances *are* checked properly. A structured export would turn the
tie-outs from "the AI says these agree" into "the software confirmed it" — the
single biggest improvement available to how much this can be trusted.
