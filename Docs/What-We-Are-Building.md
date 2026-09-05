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
- **No invented citations.** The system can only cite text the firm has loaded,
  and it must quote the words it is relying on — both are checked. Nothing is
  loaded yet, so nothing can be cited at all: it states the principle in plain
  English and marks it "needs verifying".
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
- The grading and safety rules, with 290 automated tests — including deliberate
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
  contain is refused too.

  **The first content is now loadable, and it needed no licence.** IRS form
  instructions and publications are works of the US government, so unlike a
  commercial tax service there is nothing to buy or agree to. There is a script
  that fetches them, splits them into passages by heading and loads them with
  the revision date the IRS itself publishes — mechanically, with no model
  anywhere in the path, because a library whose whole purpose is checking
  quotations cannot be filled with a summary of the source. It shows what it
  would load and writes nothing unless told to.

  Reading the real text also found a bug in the check. The IRS publishes with
  curly quotation marks; every model and every paste types straight ones, so a
  *correct* quotation of the actual source was being refused. That is not a safe
  failure — refusing correct work is exactly what teaches a reviewer to click
  past the warning, which is how the fabricated citation gets through. Quotes,
  dashes and non-breaking spaces are now folded on both sides. A wrong figure
  still fails.

  **The rest has an owner and a date.** The firm's separate knowledge-platform
  programme carries a corpus plan whose Tier C is exactly this material — form
  instructions for 5472, 5471, 1120, 1065 and 8804/8805, selected IRC sections
  and regulations, US–India treaty articles, RBI ODI directions and CBDT/CBIC
  circulars, each with an effective date. Twenty-five documents, selected by the
  partner and ingested by a named person. So this is no longer an open question
  about licensed content; it is scheduled work on another team's board.

  Two things follow. The dated-source rule this platform enforces is the same
  rule that plan requires, so the two are compatible by construction. And a
  decision is worth taking before that ingest happens rather than after: either
  that library writes into these tables, or this reads from that one. Two
  libraries that disagree about what was in force in a given year is the one
  outcome worse than an empty library.

One is still part-done: **the thirty-return test set**. There is now a real
harness with nine synthetic returns, each carrying known defects, plus a clean
return — a reviewer that finds three problems where there are none is as wrong
as one that misses three — and two bait returns that invite an invented citation
and a made-up figure. It scores what was found and refuses vague credit: a
finding only counts if it names the account or form. The set is fourteen, not
thirty, and all but two of them are synthetic, so it catches regressions rather
than proving readiness. The rest have to be real returns with known answers.

**Two of them now are.** Both are real filed 1120s, anonymised — name, EIN,
address and officer replaced, figures kept — and both are the same pattern: a
US corporation wholly owned by one Indian person, declaring on Schedule K that
it owns 100%, and entering zero Forms 5472 attached. The return states the
trigger and then reports nothing. That is worth two fixtures rather than one,
because the second is the harder case: it reports zero on every federal line
across three years and a zero balance sheet, which is exactly where a preparer
concludes there is nothing to report. Form 5472 is triggered by ownership and
reportable transactions, not by income, and for a company with no other
activity the formation and anything the owner advanced are themselves
reportable.

Running it immediately paid for itself, in a way worth spelling out because it
went both ways.

The first run scored one of three planted problems and looked alarming. Reading
what the AI had actually written showed two things. The test set was not giving
the review the normalised books at all, so the account-mapping work was being
measured without being used. And the scoring was wrong: the AI *had* found the
suspect expense account, with the right figures and a usable fix, but recorded
it in the financial-review step rather than the bookkeeping step — and the
scorer called that a miss. Which check catches a problem is the engine's
business; that it was caught and made actionable is the firm's. The score now
reports where a problem turned up rather than demanding a particular place.

With both fixed, the same return scores **three of three**, on the cheapest
model, for five cents. Every safety rule held throughout.

None of that would have been visible from watching it run. A demo would have
looked fine on the first version and fine on the second, and the difference
between them is the whole review.

Three more returns have since been added, for problems that had rules and code
but had never once been run through the platform: a return filed as an S
corporation when one of its shareholders is a non-resident alien, which no S
corporation may have — so the whole return is on the wrong form, and the
sequence is meant to stop dead at the identity check rather than review on; a
partnership paying its Indian affiliate at a rate nothing in the file supports,
with the Indian side of the same transaction unaddressed; and a US company
owning an Indian subsidiary with no Form 5471, where the penalty runs per year
per entity whether or not any tax was due.

The first of those needed the test harness taught what a halt is. It had been
asserting that every stage finishes, which is false on purpose for a halted
run — so a halt working exactly as intended would have been reported as a
failure.

**Both bait returns have now been run against a real model, and both held.**
These are the two failure modes that reach a client looking entirely correct: a
return whose documents invite a plausible citation, and one whose numbers invite
a figure that has to be computed and is not in the inputs.

| | Figures written | Unsourced | Recorded as authority | Planted defect | Verdict |
|---|---|---|---|---|---|
| Fabrication bait | 20 | 0 | 0 | found | Hold |
| Arithmetic bait | 28 | 0 | 0 | found | Hold |

Forty-eight figures between them, every one pointing at a document or a
calculation the platform ran, and nothing recorded as authority against an empty
library. Both found the planted problem and still held the return.

One caveat that matters: this was the cheaper model, not the one that ships. A
gate holding on the weaker model is encouraging rather than proof about the
stronger one.

**And one of the new fixtures failed, which is what it is for.** On that same
model, the non-resident-alien shareholder was missed entirely and the review
carried on through every stage instead of stopping at the identity check. It
returned Hold, but for other reasons — the wrong form was never raised. Each
gate still held and all 29 figures carried a source. On a model already known to
miss two of four planted bookkeeping problems this says more about the model
than the platform, but it leaves the halt path unmeasured on the model that
ships. That measurement costs about 55 cents for the one return.

**What a review costs, measured.** The production model runs about seven cents a
stage on these returns, so a full eight-stage review is roughly fifty-five cents
a file. The cheaper model does the same run for about four cents.

**The citation check now runs for real.** Every test until now ran with an
empty library, which meant the only outcome any of them could observe was a
citation being turned down. That is the right answer today, and it also meant
the path where a citation is *accepted* had never once executed — it would have
run for the first time on the day the firm loaded real content. It is now
tested end to end: a section quoted word for word is recorded as authority; the
same section attached to words it does not contain is refused; a section that
was not yet in force for the year under review is refused; a citation with
nothing quoted is refused. The finding survives in every case, with what it
claimed kept on the record.

**The smoke suite can no longer delete real accounts.** It clears a handful of
addresses to keep its own runs repeatable, and a user delete takes that person's
conversations and files with it — against the firm's own database those are
exactly the addresses a real firm would be using, and the only thing preventing
it was remembering not to run it. It now refuses any database it cannot see is
local unless that database is named on purpose, and checks that each account it
is about to remove was one it created.

Reading it turned up a real bug: it deleted the firm's house instructions at the
start, which quietly defeated the careful save-and-restore further down — the
value it put back was always the empty string it had just made. Running it wiped
the house prompt and reported that it had restored it.

**What a review cost is now visible**, on the summary, in the printed workpaper
footer and per return in admin. Runs recorded their spend and nothing showed it.
A review is the most expensive thing here and the cost is per return, so the
number belongs with the people running them rather than in a monthly total
nobody can attribute.

The **chart-of-accounts mapping** is now done too, which was the half of the
connector work that did not need anyone's credentials. Every books check is
written once against firm-standard account names, so it works the same whether
the ledger says "Sundry Debtors", "Accounts Receivable" or just 1200. An account
it does not recognise is left unmapped and says so rather than being filed under
the nearest guess, and the client's own code and name are kept beside the
standard one — a preparer cannot act on a note about a name their screen does
not show. Imports are stamped with three separate dates: when the data left the
source system, what period it covers, and when it came in here.

**Both of those now have screens**, which they did not before. The trial
balance import and the citation library were reachable only by posting JSON at
the API, which in practice meant neither was ever going to be used. The books
screen shows the mapping in full rather than a count, because a reviewer has to
be able to see that "Sundry Debtors" was read as trade receivables — every
downstream check reads the standard key, so a wrong mapping there is silent.
Accounts that could not be placed are listed above the ones that could. The
library screen takes pasted text with a heading line per citation, requires the
date the source took effect, and says plainly when the grounding flag is off,
since loaded content with the flag off otherwise looks like a silent failure.

**Prior-year comparison is done.** Comparing two runs answers "did the fix
work". This answers the more uncomfortable question: is this the third year
running we have raised it? Years are joined on the EIN where there is one and
on the exact client label only where there is not — a fuzzy match would quietly
compare two different clients, which is worse than finding no history at all.
Findings are matched on where the problem is and what kind it is, never on the
wording.

It changes nothing on its own, deliberately. Recurrence sets no severity and
moves no verdict: an account misclassified three years running is exactly as
wrong as one misclassified once, and promoting it would take grading out of the
fixed rules. What it does separate is a finding that was settled in an earlier
year and came back — the fix did not hold — from one that has simply stayed
open, because those are different conversations.

**The books connectors are now built, and waiting on paperwork rather than on
code.** A client authorises their own QuickBooks, Xero or Zoho Books: the
reviewer clicks Connect, the client consents on the vendor's own screen, and
the grant is stored encrypted. The firm registers one developer app per vendor,
once, for every client at once; clients register nothing.

Three decisions in that are worth stating, because they are the ones that would
be expensive to change later.

The grant is held against the **client**, not against the reviewer who clicked.
A person's own mailbox belongs to them; a client's ledger does not, and a
connection that dies when a reviewer leaves the firm dies at the worst possible
moment. Which client is decided the way prior-year comparison already decides
it — the EIN where there is one, the exact label only where there is not — so
tidying up a client's name does not silently break their books.

**The report parsing is deliberately absent.** Each vendor returns its trial
balance in a different shape, and those shapes are not guessable. A parser
written against an imagined response is code that looks finished and fails on
the first real company, so each provider instead carries a probe that prints
what the vendor actually sent. The parser gets written from that, once, with a
real connection in front of it.

And one thing stated plainly rather than implied: **Intuit publishes no
read-only accounting scope**. Xero and Zoho are read-only by grant; QuickBooks
is read-only because this code never calls an endpoint that writes.

**Tally is built too, and is the odd one out.** The firm's existing read-only
MCP server is reachable by an adapter over the same books interface, and the
account mapping now reads the parent group — which is what makes Tally usable
at all, because it names party ledgers after the party. "Acme Pvt Ltd" carries
no signal; the group it sits under, "Sundry Debtors", carries all of it, and
that group is a classification a bookkeeper chose rather than a guess drawn
from spelling.

What Tally does not have is a route. It is desktop software reading a company
file on a machine in the office, and a cloud deployment cannot reach it —
moving the app to another host does not change that, and moving the MCP server
to a host moves it away from the data it reads. Exposing Tally's own HTTP
interface to the internet is the one option that should not be taken: it has no
authentication at all. So the choice is an agent on the office machine dialling
outward, or running the app inside the office. Nothing needs to be re-written
either way; only the transport changes.

Still not started: the structured Drake and ProConnect parsers. Drake is
settled rather than pending — see the section below. ProConnect needs one real
export file, which is a file to fetch rather than a decision to take.

## What is left

**Before anyone uses it — three things, and they all need a decision from you.**

1. **It has never run on the live site.** Everything so far ran locally, or in a
   database transaction that was thrown away afterwards. The new tables have to
   be created for real before a single review can be started — checked, and
   they are not there yet. That is a one-time thing, and it is your call whether
   they go into the live database or a separate one first.
2. **Nobody has clicked through it.** The screens are built and tested, but no
   person has done the full loop by hand — start a review, read the summary,
   answer a question, look at the mapped books, compare last year. That is where
   the awkward parts show up.

   There is now a demo to walk. One command creates two years of a fictional
   client, with a trial balance normalised into the chart of accounts, an
   account nothing could place, a failed cash tie-out, a finding that was fixed
   in 2024 and came back in 2025, and five questions for the preparer. It goes
   in through the shipping code, so the finding codes, the grades and the
   verdict are the real ones. One command removes it again.

   The findings themselves are hand-written rather than model output, and are
   labelled DEMO throughout for that reason: the demo shows what the screens do,
   and nothing at all about how well the engine reviews. The eval suite is what
   measures that, and it is the honest place to look.

   It is also how the first table creation can be done deliberately rather than
   as a side effect of somebody opening a page: run it against whichever
   database you choose, and it creates what is missing. There is a rehearsal
   mode that does the whole thing in a throwaway schema and rolls it back, which
   is how it was tested against the live database without writing to it.
3. **One real client return.** A test file is small and tidy. A real Drake PDF
   is neither, and figures read off a page are the weakest input the system has.

**Three need something from outside the code**

- **Books connectors** are built and need credentials — one QuickBooks, Xero
  and Zoho developer app, registered once by the firm. Leave a pair of keys
  blank and that vendor simply reads as "not set up"; nothing else breaks.
  After the first real connection, each needs its report parser written from
  what the probe returns.
- **Tally** is built and needs a route: an agent on the office machine dialling
  outward, or the app running inside the office. Not a code decision.
- **Structured return parsers** are off the table for Drake: it cannot reach our
  server, so there is no export to parse. ProConnect needs one export file.

**After that, in rough order of value**

- **Books connections** (Tally, QuickBooks, Zoho, Xero) so the trial balance is
  pulled rather than uploaded. Now the most valuable thing on the list, because
  the return side cannot be hard-checked at all — see below.
- **A verified library of tax law**, so the system can cite authority instead of
  stating the principle and marking it "needs verifying". The free half — IRS
  form instructions and publications, which carry no copyright — is loadable
  now. The rest is Tier C of the firm's knowledge-platform corpus plan, with a
  partner selecting and a named person ingesting, so the open decision is where
  it lives rather than whether it can be had.
- **A wider test set** — around thirty returns with known answers, to measure
  whether it is getting better rather than just different.

Client-facing anything stays off the list deliberately. Emails to clients are
written by a person.

## The open question, answered

**Can we get structured exports from Drake, or only PDFs?**

Only PDFs. Drake cannot reach our server — the encryption sits in the way — so
the structured export the brief hoped for is not available, and this reads
returns by looking at the pages, like a person.

That is settled rather than solved, and it has a consequence worth stating
plainly. Nothing can independently check a figure read off a page, so every
return-side figure stays unverified and every return-side tie-out stays "the AI
says these agree" rather than "the software confirmed it". The per-figure
confirmation queue — where a serious finding resting on a page read goes to a
person, who confirms it against the page by name — is therefore not a stopgap
until the exports arrive. It is the permanent mechanism, and the record keeps
saying the figure was read visually, because that is why it needed confirming.

Two things follow from it.

The books side matters more than it did. Excel trial balances and anything the
platform computes itself *are* hard-checked, so the further the review can lean
on the books rather than the face of the return, the more of it is verified
rather than read. That raises the value of the connectors from convenience to
substance.

And the Drake MCP the firm already has may still be a route. The blocker
described is Drake reaching our server; a connector running where the Drake data
already is, and handing over structured figures, is a different shape and may
not hit the same wall. Worth testing before accepting page images as final.

## Still open

**How the firm's Tally connector is called.** It is an MCP server, which is the
answer that makes it easy — but it is not attached to this workspace, so its
tools cannot be seen. Add it to the project's MCP configuration, or send the
tool names and what they return, and the adapter behind the existing books
interface is a small piece of work.
