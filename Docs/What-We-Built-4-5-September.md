# What we built, 4–5 September 2026

Two days. Day one finished the review engine; day two connected it to the
outside world and put real returns through it.

For what the platform *is*, read What-We-Are-Building.md. This is only what
changed on these two days, and what it cost.

---

## 4 September — the engine finished

The review engine went from "the stages run" to "a reviewer could use this".

- **The one-page summary**, findings openable down to where each figure came
  from, and the whole register in one view.
- **The loop a reviewer actually walks** — ask the preparer, record the answer,
  re-run only the stages that answer could have affected, put run 2 beside
  run 1, sign off against the exact version the approver read.
- **Every figure scored by how it was obtained.** Computed is certain, quoted
  from readable text nearly so, read off a page image not checkable at all.
  Serious findings resting on a page read go to a person to confirm by name.
- **The citation library** — dated authority, and a check that the quoted words
  are really in the passage.
- **The chart of accounts.** Every books check written once against
  firm-standard names, so it works whether the ledger says "Sundry Debtors",
  "Accounts Receivable" or 1200.
- **Prior-year comparison** — is this the third year running we have raised it,
  and did an earlier fix hold.
- **The eval suite**, which immediately paid for itself twice: it found that
  the test set was not giving the review the normalised books at all, and that
  the scorer was calling a correct finding a miss because it turned up in the
  wrong stage.
- **Two screens that did not exist** — the books import and the citation
  library were reachable only by posting JSON, which meant neither was ever
  going to be used.
- **The smoke suite stopped being able to delete real accounts.** Reading it
  turned up a live bug: it wiped the firm's house instructions and reported
  that it had restored them.

## 5 September — the outside world

**Two real client returns went in.** Four Drake PDFs, no trial balances. Both
1120s declare a sole 100% Indian owner on Schedule K and enter **zero Forms
5472 attached** — the return states the trigger and then reports nothing. Each
missing form is $25,000 a year. Both are now anonymised fixtures with the
answers written down. The two 1065s do not need a 5472 and already carry their
withholding schedules.

**The books connectors were built.** A client authorises their own QuickBooks,
Xero or Zoho Books; the firm registers one developer app per vendor, once,
covering every client. Tokens encrypted, refresh handled, a withdrawn grant
reads as "reconnect" rather than failing at import time months later.

**Tally too**, as an adapter over the firm's existing read-only MCP server —
plus the change that makes Tally usable at all: mapping on the parent group,
because Tally names party ledgers after the party and "Acme Pvt Ltd" tells you
nothing that "Sundry Debtors" does not.

**The citation library got its first real content.** IRS form instructions are
US government works and carry no copyright, so the free half needed no licence
at all — 5472 and 1120, 195 passages, loaded with the revision date the IRS
publishes.

---

## Three things worth remembering

**A summary is not a source.** The first attempt at loading the instructions
came back partly paraphrased, because it had been read through a model. Loading
it would have let citations verify against words the IRS never wrote — the
exact failure the library exists to prevent. It now extracts mechanically, and
no model is in that path.

**Refusing correct work is not a safe failure.** Reading real IRS text found a
bug in the citation gate: the IRS publishes with curly quotation marks, every
model and every paste types straight ones, so a *correct* quotation of the real
source was being refused. That is how a reviewer learns to click past the
warning, which is how the fabricated citation gets through. Fixed. A wrong
figure still fails.

**Guessing a response shape is the same mistake twice.** Neither the Tally
adapter nor the three cloud connectors parse their reports yet. Each has a
probe that prints what the vendor actually returned, and the parser gets
written from that — with a real connection in front of it, once.

---

## What it cost

Nothing. No model runs on either day; every suite is deterministic and spends
no money. The paid measurements were made earlier: about seven cents a stage on
the production model, so roughly fifty-five cents for a full review of one
return, and four cents on the cheap one.

## What is waiting

| | Needs |
|---|---|
| QuickBooks / Xero / Zoho | Three developer-app registrations |
| Tally | A route — an agent on the office machine, or the app inside the office |
| Citation library | The rest is Tier C of the firm's corpus plan; decide where it lives |
| ProConnect | One real export file |
| Thirty-return set | Fourteen, twelve of them synthetic |
| The app itself | Nobody has clicked through it by hand. The demo is seeded and waiting |

Drake is settled rather than pending: it cannot reach our server, so page
images are permanent and the per-figure confirmation queue is the mechanism
rather than a stopgap.
