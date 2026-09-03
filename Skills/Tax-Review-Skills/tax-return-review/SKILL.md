---
name: tax-return-review
description: Senior-CPA final review of a US business or individual tax return prepared in Drake (or ProConnect) — books-to-return tie-out, US GAAP expense classification, financial reasonableness, return-level checks for 1065, 1120, 1120-S, 1120-F, 1040, 1040-NR and dual-status, the international information returns (5471 with GILTI/Subpart F, 5472, 8858, 8865, 8621, 3520, FBAR/8938, 1042/1042-S, 8804/8805, 926, 8833), every state and city return with apportionment, PTE and non-resident withholding, and the India-side mirror (ODI/FEMA, APR, Form 3CEB, TDS, Indian ITR) for every cross-border fact — plus plain-English fix instructions for the Drake operator and 5–10 clarification questions for the preparer. Use whenever a return is "ready for review", "ready to file", needs QC, sign-off, or a second look; whenever a trial balance, P&L or balance sheet is uploaded alongside a return; whenever someone asks what a senior CPA would check before finalising; or whenever the platform is asked to review, assess, verify or approve a prepared return. Trigger even if the request is only "check the balance sheet" or "does M-1 look right" — a partial review always runs the full sequence, because errors hide in the sections nobody asked about.
---

# Tax Return Review

## What this skill does

It replicates the sequence a senior CPA follows from "preparer says done" to
"cleared for e-file". It runs in three stages, in a fixed order, and produces
one findings register plus a short list of questions for the preparer.

| Stage | Question it answers | Reference file |
|---|---|---|
| 1. Books and bookkeeping | Are the numbers the return is built on right? | `references/stage-1-books-and-gaap.md` |
| 2. Financial evaluation | Do the numbers make sense for this business? | `references/stage-2-financial-evaluation.md` |
| 3. Return assessment | Is the return itself correct, complete and filable? | `references/stage-3-<return-type>.md`, then international forms, state, India symmetry |

Then: `references/drake-fix-guide.md` (how to fix), `references/question-generator.md`
(what to ask the preparer), `references/output-schema.md` (what the platform emits).

**Never skip Stage 1 to get to Stage 3.** Most return errors are book errors
that were faithfully copied onto the form. Fixing the form without fixing the
books means the same error returns next year and the balance sheet stops rolling.

## Who reads the output

A novice Drake operator. Every finding is written so that person can:
1. Understand what is wrong in one sentence
2. Know where to look in Drake
3. Know what to change
4. Know why (one line)

No jargon without a plain-English gloss. No "consider whether" — say what to do,
or say what fact is needed to decide.

## The three hard rules

**Rule 1 — The AI does not compute, and does not decide filing obligations.**
The model reads numbers, compares numbers, and flags numbers. It never
originates a number that reaches the register. Depreciation, tax, penalties,
apportionment, thresholds, and due dates come from the calculation layer or
from Drake itself. If a figure is needed and is not in the inputs, the finding
says "needs computation" and names what to compute. (Firm rule: `usaindiacfo-ai-guardrails`, Gate 1.)

**Rule 2 — No citation without a source, and no source means no citation.**
A code section, regulation, form instruction or penalty figure appears in a
finding only if it was retrieved from the platform's verified corpus. Otherwise
the finding states the principle in plain English and tags `authority: verify`.
A plausible-looking citation that was not retrieved is a build failure, not a
style issue. (Firm rule: `partner-review`, Rule 0.)

**Rule 3 — Nothing is "fine" without evidence.**
Every stage produces at least one line in the register, even if it is
"Reconciled, no exception — TB total $X agrees to Schedule L line Y". A reviewer
who sees a silent section does not know whether it was checked or skipped.

## Inputs the review needs

Ask for anything missing before starting Stage 1. Do not start with a partial set
and "assume" the rest.

| Input | Required for | If missing |
|---|---|---|
| Drake return PDF or export (all forms, schedules, statements, worksheets) | Stage 3 | Stop — cannot review |
| Trial balance at year end, and prior year end | Stage 1, 2 | Stop — cannot tie out |
| General ledger detail (or QBO/Zoho export) | Stage 1 | Proceed, flag every account not sampled |
| Prior-year return as filed | Stage 2, 3 | Proceed, flag all rollforward checks as unverified |
| Bank/loan statements at year end | Stage 1 | Proceed, flag cash and debt as unreconciled |
| Fixed asset register / depreciation schedule | Stage 1, 3 | Proceed, flag depreciation as unverified |
| Ownership schedule, K-1 % , related-party list | Stage 3 | Stop for 1065 / 5472 — cannot review allocations or reportable transactions |
| Preparer's notes and open-item list | All | Proceed, but the question list will be longer |
| Engagement letter / scope | All | Proceed, flag scope as assumed |

## Review sequence (do not reorder)

### Stage 0 — Scope, identity, and period (5 minutes)
- Confirm entity name, EIN, address, fiscal year, entity type and state of
  formation agree between the return, the engagement record, and last year.
- Confirm the return type is the right one. An LLC taxed as a partnership filing
  an 1120, or a foreign-owned single-member LLC with no 5472 attached, is a
  Stage 0 failure and everything else waits.
- Confirm the period: short year, first year, final year, fiscal year. Each
  changes what Stage 3 must check.
- Confirm which jurisdictions are in scope (federal, states, city) and that the
  obligation engine's list of required forms matches what Drake has generated.
  Missing form = Critical finding, before any line-item review.

### Stage 1 — Books and bookkeeping
Read `references/stage-1-books-and-gaap.md`. Output: reconciled trial balance,
list of proposed book adjustments, list of accounts needing a second look.

### Stage 2 — Financial evaluation
Read `references/stage-2-financial-evaluation.md`. Output: analytical review
table (current vs prior, ratios), list of anomalies with the question each raises.

### Stage 3 — Return assessment
Run the modules in this order for the return type. Every listed module is
mandatory when its trigger is present; "not applicable" is itself a register
line with the reason.

| Return type | Modules (in order) |
|---|---|
| 1065 | `stage-3-1065.md` → `stage-3-international-forms.md` (if any foreign partner / foreign holding / foreign account) → `stage-3-state.md` → `stage-3-india-symmetry.md` (if any Indian owner or affiliate) |
| 1120 / 1120-S | `stage-3-1120.md` → `stage-3-1120F-5472.md` §A (if any 25% foreign owner) → `stage-3-international-forms.md` → `stage-3-state.md` → `stage-3-india-symmetry.md` |
| 1120-F | `stage-3-1120F-5472.md` §A, B, D → `stage-3-international-forms.md` → `stage-3-state.md` → `stage-3-india-symmetry.md` |
| Foreign-owned DRE (pro-forma 1120 + 5472) | `stage-3-1120F-5472.md` §A, C, D → owner's own return module → `stage-3-state.md` → `stage-3-india-symmetry.md` |
| 1040 | `stage-3-1040.md` → `stage-3-international-forms.md` (any foreign link) → `stage-3-state.md` → `stage-3-india-symmetry.md` (Indian income / assets / family) |
| 1040-NR / dual-status | `stage-3-1040NR.md` → `stage-3-international-forms.md` → `stage-3-state.md` → `stage-3-india-symmetry.md` |

Form-to-module index: `references/INDEX.md`.

### Stage 4 — Fix instructions and questions
- For each finding, write the Drake fix using `references/drake-fix-guide.md`.
- Generate 5–10 preparer questions using `references/question-generator.md`.
- Emit the register in the format in `references/output-schema.md`.

## Finding format

Every finding, in every stage, has exactly these fields:

| Field | What goes here |
|---|---|
| ID | S1-001, S2-001, S3-001 … (stage prefix, sequential) |
| What is wrong | One plain sentence. "Schedule L cash ($42,180) does not agree to the bank reconciliation ($41,930)." |
| Where | Form, schedule, line — and the book account it came from |
| Severity | Critical / High / Medium / Low (definitions below) |
| Why it matters | One line. "Balance sheet will not roll next year; IRS matches L to M-2." |
| Fix in Drake | Screen or location in plain English, what to enter, what to re-check after |
| Authority | Retrieved citation with source pointer, **or** `verify` |
| Evidence | Which document proves the correct figure |
| Owner | Preparer / Reviewer / Client (needs client input) |

### Severity

| Level | Meaning | Effect |
|---|---|---|
| Critical | Wrong number, wrong classification, missing form, or wrong entity type would be filed | Return is on hold |
| High | A position is taken with no support, or a tie-out fails and the cause is unknown | Return is on hold until answered |
| Medium | Figure is right but workpaper evidence is missing; would not survive an IRS query | Can release with a condition and owner |
| Low | Presentation, rounding, naming, statement wording | Release; fix if time permits |

## Verdict

Close every review with one of three verdicts and nothing softer:

| Verdict | When |
|---|---|
| **Clear for release** | No Critical or High open; all Medium have owner and date |
| **Release with conditions** | No Critical; High items are answered by preparer questions whose answers are expected before e-file |
| **Hold** | Any Critical open, any missing required form, any unreconciled cash or equity |

Then list: conditions (with owner and date), positions to register, and the
question list for the preparer.

## What the reviewer does with AI output

The platform's output is the *first* reviewer, not the last. A named human
signs off, and that person must see the findings, the source documents each
finding points to, and the questions the preparer answered. The platform records
who approved, when, and which version of the register they saw.

AI-drafted client emails are never sent. If a finding needs client input, the
register says so; the partner writes the email.
