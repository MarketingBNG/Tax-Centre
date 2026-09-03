# Form-to-module index

Find the form; open the module. Every form the firm files should appear here —
if one does not, that is a gap in this skill, not a reason to skip the check.

## Federal income tax returns
| Form | Module |
|---|---|
| 1065, Schedules B, K, K-1, L, M-1, M-2, K-2/K-3, 8825, 1125-A | `stage-3-1065.md` |
| 1120, Schedules C, J, K, L, M-1, M-2, M-3, 1125-A, 1125-E, 2220, 851 | `stage-3-1120.md` |
| 1120-S, Schedules K, K-1, L, M-1, M-2, 7203, 2553 | `stage-3-1120.md` (1120-S section) |
| 1120-F, Sections I–III, Schedules H, I, L, M-1, M-2, P; protective return | `stage-3-1120F-5472.md` §B |
| Pro-forma 1120 for foreign-owned DRE | `stage-3-1120F-5472.md` §C |
| 1040, Schedules 1–3, A, B, C, D, E, SE; 8949, 1116, 4562, 8995 | `stage-3-1040.md` |
| 1040-NR, Schedules NEC, OI; 8843, 8840; dual-status statements | `stage-3-1040NR.md` |

## International information returns and withholding
| Form | Module |
|---|---|
| 5472 (all parts) | `stage-3-1120F-5472.md` §A |
| 5471 and Schedules A–R; 8992; 8993; §962 statement; 1118 | `stage-3-international-forms.md` §1–2 |
| 8858 and Schedule M; 8832 | `stage-3-international-forms.md` §3 |
| 8865 and schedules | `stage-3-international-forms.md` §4 |
| 8621 | `stage-3-international-forms.md` §5 |
| 3520, 3520-A | `stage-3-international-forms.md` §6 |
| FinCEN 114 (FBAR), 8938 | `stage-3-international-forms.md` §7 |
| 1042, 1042-S, W-8BEN / BEN-E / ECI / IMY | `stage-3-international-forms.md` §8; `stage-3-1120F-5472.md` §D |
| 8804, 8805, 8813, 8804-C; §1446(f) | `stage-3-international-forms.md` §9; `stage-3-1065.md` |
| 926, 8833, 2555 | `stage-3-international-forms.md` §10 |
| 8288, 8288-A, 8288-B (FIRPTA) | `stage-3-1040NR.md` §3.2; `stage-3-international-forms.md` §0 |
| 8854 (expatriation), 1040-C | `stage-3-1040NR.md` §3.1 |

## Common attachments
| Form | Module |
|---|---|
| 4562, 4797, 8949, Schedule D | Each return module §attachments; book/tax difference in `stage-1-books-and-gaap.md` §1.5 |
| 8990 (§163(j)) | `stage-3-1065.md` §3.2; `stage-3-1120.md` §3.2 |
| 3115 (method change) | `stage-1-books-and-gaap.md` §1.1; `stage-2-financial-evaluation.md` §2.3 |
| 7004 / 4868 extensions | Each return module §attachments; due dates from obligation engine |
| Elections: de minimis safe harbour, §179, bonus opt-out, §754, §174, §871(d) | `drake-fix-guide.md` rule 5; relevant return module |

## State and local
| Item | Module |
|---|---|
| State corporate / partnership / individual income returns, apportionment, modifications, NOLs, credits | `stage-3-state.md` §3.1–3.6 |
| PTE elections, composite returns, non-resident owner withholding, state K-1s | `stage-3-state.md` §3.4 |
| Franchise / net-worth / minimum taxes computed on the income return | `stage-3-state.md` §3.5 |
| City / local income and business taxes | `stage-3-state.md` §3.7 |
| Annual reports, sales tax, gross-receipts, property returns (not inside the Drake return) | Obligation engine; `stage-3-state.md` §3.8 |

## India-side mirror
| Item | Module |
|---|---|
| ODI / OPI, UIN, Form FC, APR, FLA, LRS, financial commitment, round-tripping, disinvestment | `stage-3-india-symmetry.md` §A; full analysis in `fema-odi-review` |
| FDI into India: FC-GPR, FC-TRS | `stage-3-india-symmetry.md` §A |
| Form 3CEB / TP study; TDS (Form 16A, 26AS, 15CA/CB); GST on cross-border services | `stage-3-india-symmetry.md` §B |
| Indian ITR (Schedule FA, Form 67 DTAA credit, residency) | `stage-3-india-symmetry.md` §C |

## Books, evaluation, output
| Item | Module |
|---|---|
| Trial balance, reconciliations, GAAP expense sweep, equity roll | `stage-1-books-and-gaap.md` |
| Variance, ratios, cross-document matching | `stage-2-financial-evaluation.md` |
| Fix wording for the Drake operator | `drake-fix-guide.md` |
| Preparer questions | `question-generator.md` |
| JSON output, validation rules, eval set | `output-schema.md` |
| Register template | `../assets/findings-register-template.md` |
