# Reply to the Box spec

**To:** Akshay Nahar
**From:** Karan Narania, Technology & Automation Lead
**On:** Box-Powered End-to-End Specification, 6 September 2026

The Box inspection is the most useful thing anyone has handed this project. The
folder convention really is deterministic, the file naming really is consistent,
and the finding that extracted return text carries live SSNs is the right thing
to have put at the top.

You asked to be corrected where the Centre already does something, so this is
that reply. Six points, then three questions only you can answer.

---

## 1. Nothing to strike on Box — but three items are largely built

I checked the closing caveat first. **The Centre does not read from Box.** There
is a Box connection, but it is a per-user chat connector: it can search and read
plain-text files, and it refuses PDFs outright. It has never listed a folder, and
the review engine cannot reach it. So nothing on the backlog is already
implemented by an existing Box connection.

Three items are substantially built by other means:

**Item 13, the five-line format — about 90% done.** A finding is not prose. It
is stored as typed fields that already match your five lines: `what_is_wrong`
(WHAT), a location record holding form / schedule / line / GL account (WHERE —
and your "always both" rule is why those are four separate fields), and a fix
record holding `change`, `then` and `why`. All four are mandatory on the model
that produces them; a finding with no fix is refused. The finding code is
already `S1-001`-shaped, and the grade is computed by fixed rules from the
defect type — the model cannot write a severity at all.

Your "state both branches and raise a question" rule is also there, and stricter
than specified: an answer in words alone cannot close a Critical or High finding.

What genuinely remains is small. The "always both" rule is stated but not
enforced — a finding can currently be stored with all four location fields
empty, and that should refuse. There are two WHEREs (the form the defect is at,
versus the Drake screen to go to) and two WHYs, which should each become one.
And the render order is not guaranteed on every screen. Two or three days, not a
rebuild.

**Item 3, access logging — a few hours.** The audit log exists, has one writer,
44 recording sites and an admin screen. Every *write* is recorded. **No read
is.** Adding four call sites closes it. This is the cheapest item on your list
and I have done it (see the end of this note).

**Item 7's hard half is done.** The obligation grid, the required-forms
calculation and the forms-present-versus-required comparator all exist, and the
verdict already Holds a return with a missing form. Only the "present" side is
missing.

---

## 2. Please drop the token map

The spec asks for "a token map so findings can still reference 'the SSN on page
1' without carrying the value." The design already does exactly that, and does
it better than a map would: tokens are derived by HMAC of the value, so the same
EIN becomes the same token in every document and every conversation, **with no
mapping table to leak.** A finding can say "the SSN on page 1"; the reviewer
opens the document.

A reversible map would create something that does not exist today: a single
table mapping tokens to live Social Security numbers for every taxpayer in the
firm's book of business, readable by anything that can read the database or a
backup. For a firm doing IRS representation that is the highest-value target the
system could contain, and it would be built to serve a need already met.

There is a real gap the word "map" is reaching for: nothing records *where* an
identifier was seen, so a reader cannot tell whether `[EIN-…]` was the entity's
own EIN or a payer's. That wants an occurrence index — token, kind, file, page —
**with no value column.** Same usefulness, none of the exposure.

**One related thing that must not happen.** The database comment on the EIN
column claims the EIN is tokenised. No code ever did that, and it must not
start. A client's cross-year history is matched on that exact value, so
tokenising it would make client identity depend on a 32-byte secret that is
generated on first use, never rotated, never exported, and has no reverse
function. One lost row would erase every client's prior-year history
irrecoverably. I have corrected the comment and removed the EIN from the prompts
instead — the review never needed it.

---

## 3. Item 1 depends on item 6, which the phase numbering hides

This is the one I would most like understood before rollout.

For a native-PDF return, "mask every identifier before it reaches any model"
**cannot be satisfied**, and no amount of Phase 1 work changes that. Returns are
PDFs. PDFs go to the model as page images, and the model reads the number off
the page. Masking that would mean rasterise, OCR, locate, black-box — which
risks covering the wrong figure and throws away the fidelity that makes the
pipeline good.

So the honest position is: **every text path can be closed, and pixels cannot.**
Its literal satisfaction depends on Phase 2's extraction ladder, because the
first PDF-derived *text* this platform ever sees will be the text Box gives us.

Which leads to something worth saying plainly: **Box improves the privacy
posture rather than creating the risk.** Every SSN on every return page already
reaches the model unmasked today, without Box being involved. Phase 1 is urgent
for reasons that have nothing to do with the partner rollout — and it is
therefore not a blocker on Box ingestion, because Box does not make it worse.
Decoupling those two is most of what makes this plan runnable by one part-time
person.

What I propose in the meantime: close every text path completely, and **disclose
the residual in numbers on the run page** — "42 pages of this return were sent
as page images; identifiers printed on those pages were not masked and cannot
be." Then make refusal the default the day the ladder lands. I would like that
substitution agreed in writing rather than assumed.

One thing the SSN frame misses: the client's full chart of accounts goes into
every books stage prompt, and for Tally clients the ledger names are the party
names — so that block is a list of every customer, vendor and employee. Not
identifiers, but not nothing.

---

## 4. Item 6 needs a decision before it needs a week of building

This is the most important technical point in the reply.

The platform grades every figure by how it was obtained. A figure read off a page
image is capped at low confidence, which puts it below the threshold that sends
it to a person to confirm by name — and a Critical finding resting on one is
escalated rather than published. That queue is not a stopgap; it is the mechanism
the team deliberately settled on once Drake turned out to be unreachable.

A figure quoted from *extracted text* is trusted much more highly, and here is
the problem: the check behind that trust is **"does this number appear anywhere
in this document."** No label, no proximity, no line matching. On a generated CSV
trial balance that is a fair proxy. On a 60-page return's text layer it is close
to meaningless — that text contains thousands of numbers, including every line
number, every form number, and every year.

So the moment Box text lands in the system, **with no code change at all**, every
figure off a return jumps to high confidence, the confirmation queue empties, and
the escalation path stops firing. The system gets quieter and less honest at the
same time.

**Item 6 is therefore not plumbing.** Before it is built, someone has to decide
what extracted PDF text is worth: I would give it its own confidence tier, below
the one that trial-balance text gets, and require label proximity rather than
"appears somewhere" before anything skips a human. That is half a day of thinking
and it must come before the week of building.

---

## 5. Item 7 does not catch our own two cases, and it would create false Holds

I traced the two real 1120s. A 100% foreign owner is recorded as a fact, the
obligation grid requires a 5472, the forms-present list lacks one, and the
verdict Holds. **The engine already catches these — and what catches them is the
fact, not the inventory.** That is item 9's job, which is why I would rank item 9
well above item 7.

Then a failure mode. "No bookmarks found" and "no forms present" are currently
the same value. A scanned return, or Drake output with no outline, would yield an
empty inventory and the verdict would raise a blocker for *every* required form.
Item 7 fails loudly in the wrong direction on exactly the documents item 6 exists
to handle. It needs an explicit "inventory could not be read" state, distinct
from "the inventory is empty" — and it should ship **after** deeper analysis, not
before it.

And the check that actually caught our two cases is not in the spec at all. Both
returns **state their own trigger and then report nothing** — Schedule K declares
a sole 100% Indian owner, and the attached-forms count says zero. There is no
missing bookmark, because there is no missing section; there is a declared zero.
A small deterministic reader over the return's self-declarations, quoting the
return's own words back, is worth more than the bookmark inventory and costs
about the same.

---

## 6. Item 2, and the thing that should have been on the list

Your instinct is right — read the permissions Box already records rather than
inventing a second model that drifts. But the named API works against the
intent: it does not return grants inherited from a parent folder, and it returns
groups rather than people. Honouring it literally means walking ancestors and
expanding groups, which is precisely the second permission model the spec warns
against one paragraph earlier.

The same intent, correctly expressed: **ask Box whether this person can open this
folder, and let Box answer.** One call, no model of our own.

On the firm-visibility objection — reviews are currently visible to everyone
signed in, deliberately, and it is written down. Reading it again, that reasoning
is about *actions inside a review*: a preparer answers a question on a run
somebody else opened, a partner approves one neither of them created. It is not a
claim that every partner should see every client. Scoping **which clients you can
list** to Box, while keeping **actions inside a client you can see** open to the
firm, honours both. That is what I would build, and no new role is needed —
visibility is data.

But item 2 is blocked on item 10. There is no clients table; the client is a
free-text label. There is nothing yet to hang a per-folder permission on, which
is why item 10 has to move out of Phase 3 and become a prerequisite.

**And the hole that is not on the list at all: anyone with a login can sign off
any review.** No check whatsoever. Sign-off is the firm's IRS-facing
attestation — it is version-checked with real care, and then handed to whoever
is signed in. Between "a partner can see a client they don't work on" and "a
junior can sign off a partner's review", the second is worse. It was a one-line
fix and I have made it.

---

## Three things only you can decide

1. **Item 12 — when the client's Compliance Calendar and the obligation engine
   disagree, which is authoritative?** I cannot size this item until that is
   answered. There is no calendar concept in the system at all, and the two
   lists barely overlap: the engine produces information-return obligations from
   entity facts, and a compliance calendar is dated recurring payroll, franchise
   and SOI filings. Without the authority question settled, most "disagreements"
   would be noise. I would defer it, and start with a look at ten real calendar
   files to find out whether they even share a shape.

2. **Item 14 — is a review summary in the client's Box folder a disclosure?**
   Item 2's whole premise is that Box collaborations already grant access. Item
   14 writes into that same access, in the opposite direction — and a summary
   naming Critical findings says "this return is wrong". If a client is ever a
   collaborator on their own folder, we would be sending them our internal
   review. It must at minimum be gated on sign-off and refuse to write a Hold.
   Also worth knowing: Box cannot express "write only under Internal Working" —
   the permission is read-only or read-write across the board, so the narrowing
   would be ours to enforce, not Box's. I would ship a "Download summary" button
   first: same value, none of the risk, about a day.

3. **Real client returns are in our git history as test fixtures.** Anonymised —
   names, EIN and address replaced, figures kept — and that was the right call
   for the eval set. But it is permanent, and whether the firm accepts that is a
   decision rather than an engineering question. Flagging it rather than quietly
   working around it.

---

## One thing worth more than any item on the list

**Nobody has clicked through the app by hand.** That is also why you could not
reach Settings or New review during the walkthrough — the demo is seeded and
waiting, and no one has driven it. Thirteen of the fourteen items assume screens
nobody has used. If New review is merely confusing, items 8 and 9 are optimising
a path no one takes.

It costs an hour and it would make every estimate in the spec mean more. I would
do that before anything else, and I would rather you or someone other than me
did it.

And one precondition we set ourselves, which the spec could not have known
about: our own eval notes say **thirty golden returns across all return types
before any version goes near a live client file.** We have thirteen. Box
ingestion would put the platform in front of 133,000 live client files.
Whichever way we sequence the rest, that gate is ours and we wrote it down.

---

## What I have already done

Two days of work, no Box involved, all of it shippable now:

- **Sign-off is authorised.** A switch that restricts it to admins, unset by
  default so nothing changes for a firm that runs flat. Self-approval is
  recorded and shown on the workpaper rather than prevented — a firm where one
  person prepares and signs off is a real firm, and the answer to that is that
  the sign-off says so.
- **Reads are logged.** Opening a client's review, pulling the client list, and
  taking the register away as a file. One row per person per client per thirty
  minutes, because the run page polls every four seconds and logging every read
  would bury the question in its own answer. Taking a copy away is never
  deduplicated. Two indexes, because the admin screen counts rows by action on
  every page load.
- **The EIN is out of the prompts** — the last four digits go instead, which is
  all the identity check ever needed. The EIN is now stored in one shape, which
  also fixed a silent bug: `12-3456789` and `123456789` were two different
  clients to the prior-year lookup, so a rollforward check could find nothing
  and say nothing.
- **The monthly cap is enforced.** It has been displayed and ignored for a long
  time. A run that hits it halts with the numbers in the message rather than
  failing, so it can continue once the cap is raised. This is a prerequisite for
  anything batch-shaped: at roughly 55¢ a return, 2,000 clients is over $1,000 a
  pass, and more once Box supplies more documents per client.
- **The client list says when it is truncated.** It has always stopped at 200,
  invisibly. That was fine when the number of clients was the number somebody had
  typed in. With 2,000 arriving from Box, a list that silently omits a client
  reads exactly like a list that has no such client.

Tests: 39 new assertions across the pure suite and two database suites, and the
existing suites still pass. The database suites run in a schema of their own and
roll back, so they are safe against the live database.
