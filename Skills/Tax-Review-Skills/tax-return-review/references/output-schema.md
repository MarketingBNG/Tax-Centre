# Output schema

The platform emits one JSON document per review run. Every field is typed;
`null` means "not determined", never an empty string. Numbers come only from the
calculation layer or from the input documents — the model supplies text and
pointers.

```json
{
  "review_id": "uuid",
  "run_at": "2026-09-03T10:15:00Z",
  "prompt_version": "trr-1.0",
  "model_id": "…",
  "corpus_hash": "…",
  "engagement": {
    "client_id": "…",
    "entity_name": "…",
    "ein": "…",
    "return_type": "1065 | 1120 | 1120-S | 1120-F | 1120-DRE-5472 | 1040 | 1040-NR | 1040-DUAL",
    "international_forms_present": ["5472", "5471", "8992"],
    "international_forms_required_by_engine": ["5472", "5471", "8992", "8938"],
    "tax_year": 2025,
    "period_start": "2025-01-01",
    "period_end": "2025-12-31",
    "short_year": false,
    "jurisdictions": ["US-FED", "US-NJ", "US-NYC"],
    "india_link": true
  },
  "inputs_received": [
    {"type": "drake_export", "doc_id": "…", "received": true},
    {"type": "trial_balance_cy", "doc_id": "…", "received": true},
    {"type": "trial_balance_py", "doc_id": null, "received": false}
  ],
  "coverage": {
    "stage_1_accounts_sampled": 42,
    "stage_1_accounts_total": 57,
    "stage_1_accounts_not_sampled": ["6410", "6420"],
    "k1_checked": 4,
    "k1_total": 4
  },
  "findings": [
    {
      "id": "S1-001",
      "stage": 1,
      "title": "Schedule L cash does not agree to bank reconciliation",
      "what_is_wrong": "Schedule L line 1 end-of-year cash is $42,180; December bank reconciliation shows $41,930.",
      "location": {"form": "1065", "schedule": "L", "line": "1d", "gl_account": "1010"},
      "severity": "High",
      "why_it_matters": "Return must agree to reconciled books; IRS matches L to next year's opening balance.",
      "fix": {
        "where": "Schedule L line 1 → balance sheet screen",
        "change": "Post Dr 6120 / Cr 1010 $250 per bank rec; re-enter TB; L line 1 = $41,930.",
        "then": "Confirm total assets = total liabilities + equity; page 1 line 22 reduced by $250.",
        "why": "Books drive the return."
      },
      "authority": {"status": "none_required | grounded | verify", "citation": null, "source_span": null},
      "evidence": [{"doc_id": "…", "description": "December 2025 bank reconciliation"}],
      "amounts": [{"label": "per_return", "value": 42180.00, "source": "drake_export"},
                  {"label": "per_bank_rec", "value": 41930.00, "source": "bank_rec_dec"}],
      "owner": "preparer | reviewer | client",
      "status": "open | answered | closed | changed | escalated | client",
      "question_id": "Q-1",
      "confidence": 0.97
    }
  ],
  "questions": [
    {
      "id": "Q-1",
      "finding_id": "S1-001",
      "owner": "preparer",
      "question": "…",
      "figure": "…",
      "branches": [{"if": "…", "then": "…"}],
      "evidence_needed": "…",
      "answer": null,
      "answer_evidence_doc_ids": [],
      "answered_by": null,
      "answered_at": null
    }
  ],
  "tie_outs": [
    {"name": "K-1 box 1 total = Schedule K line 1", "left": 184220.00, "right": 184220.00, "agrees": true},
    {"name": "L partners' capital = M-2 line 9 = ΣK-1 item L", "left": 96410.00, "right": 96160.00, "agrees": false, "finding_id": "S3-006"}
  ],
  "verdict": {
    "result": "hold | release_with_conditions | clear",
    "critical_open": 1,
    "high_open": 3,
    "conditions": [{"finding_id": "S3-006", "owner": "preparer", "due": "2026-09-05"}],
    "positions_to_register": [{"finding_id": "S3-009", "position": "LLC members treated as limited partners for SE purposes", "authority_status": "verify"}]
  },
  "approval": {
    "approved_by": null,
    "approved_at": null,
    "register_version_seen": null
  }
}
```

## Validation rules (enforced in code, not by the model)

1. Every `amounts[].value` must appear in an input document or the calculation layer output; any numeric token in model text that is not in the injected set is a build error.
2. `authority.citation` non-null only if `authority.status = grounded` and `source_span` points into the corpus.
3. `verdict.result = clear` only if `critical_open = 0`, `high_open = 0`, and every Medium has an owner.
4. `verdict.result ≠ hold` requires all required forms per the obligation engine — federal, international information returns, and every state/city return — to be present in the Drake export (`international_forms_required_by_engine ⊆ international_forms_present`).
4a. If `india_link = true`, the register must contain at least one S3 finding from `stage-3-india-symmetry.md` (an open client-level item or an "agreed" line); a US verdict of `clear` does not close an open India-side item — it stays on the client record.
5. `findings` must contain at least one entry per stage (an "agreed, no exception" line counts).
6. `questions` length between 5 and 10 when any High or Critical is open; may be fewer only if fewer findings exist.
7. `approval.approved_by` must be a named user; approval records `register_version_seen`, and any later change to findings resets approval to null.
8. `confidence < threshold` routes the finding to the human queue with status `escalated`; it never silently downgrades severity.

## Eval set the platform must pass before production

| Case type | Minimum | Pass condition |
|---|---|---|
| Golden returns (anonymised, known findings) | 30 across 1065 / 1120 / 1120-S / 1120-F / DRE+5472 / 1040 / 1040-NR, each with at least one state and, where relevant, 5471 / 8858 / 8621 / FBAR | ≥ 90% of seeded findings detected; zero false Critical |
| Determination probes (fact present, form absent — e.g., Indian mutual fund with no 8621; Indian owner with no 5472; remote employee in a new state) | 15 | Every one raised as Critical |
| Fabrication probes (facts inviting a code section) | 10 | Zero citations with `status = grounded` that are not in corpus |
| Arithmetic probes (missing computed figure) | 10 | Model emits "needs computation", never a number |
| Missing-input cases | 5 | Review stops at the input gate with the correct list |
| Regression | every past production miss | Never recurs |
