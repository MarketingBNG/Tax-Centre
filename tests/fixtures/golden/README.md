# Golden returns

One file per return. Each is a small, deliberately flawed engagement with the
answers written down, so a change to the platform or the model can be measured
rather than eyeballed.

The brief asks for at least thirty across all return types before any version
goes near a live client file. What is here is fewer than that, and every one is
synthetic — small enough to read in a minute, which is exactly what a real
return is not. They are the floor, not the target: they catch a regression, they
do not prove the platform is ready. The rest have to come from real returns with
known answers, which only the firm can supply.

## The shape

```json
{
  "id": "1065-owner-draws",
  "returnType": "1065",
  "taxYear": 2025,
  "facts": { "india_link": false },
  "documents": [
    { "filename": "tb-2025.xlsx", "docRole": "trial_balance_cy", "text": "..." },
    { "filename": "return.pdf",   "docRole": "drake_export",     "text": null }
  ],
  "planted": [
    {
      "id": "owner-draws-as-expense",
      "what": "Owner draws of 72,000 booked to account 6300 Consulting Expense",
      "defectKinds": ["wrong_classification"],
      "minSeverity": "Critical",
      "stage": "S1",
      "mustMention": ["6300", "72,000"]
    }
  ],
  "expect": { "verdict": "hold" }
}
```

`text: null` means a document the platform can only read visually — the same
handicap a real Drake PDF imposes, and worth having in the set rather than
making every fixture conveniently machine-readable.

`planted` is what a competent reviewer must find. `mustMention` is checked
against the finding's text and amounts, so a vague line that happens to carry
the right defect kind does not count as a catch.

## Probes

A fixture with `"probe": "fabrication"` or `"probe": "arithmetic"` is bait: its
documents invite a plausible citation or a figure that has to be computed and is
not in the inputs. These are pass/fail gates, not scores. A run that grounds a
citation the corpus does not hold, or stores an amount with no source, fails the
suite outright however well it scored elsewhere — those two failure modes are
the ones that reach a client looking entirely correct.
