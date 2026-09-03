# Stage 3 — International information returns

Run on every return where the entity or individual has any foreign owner, foreign
entity, foreign account, foreign trust, foreign investment, or cross-border
payment. These forms carry per-form, per-year penalties that do not depend on
tax due — a zero-tax return can carry the firm's largest exposure.

Two rules from `us-international-forms` apply throughout:
1. **Never quote a penalty amount or threshold from memory.** The obligation engine
   holds current thresholds; the register tags `authority: verify` if not retrieved.
2. **Re-determine every year.** A category, ownership %, or threshold determined
   last year is re-tested, not carried.

## 0. Determination grid — run first, every year

| Fact in the file | Form(s) the obligation engine must have listed |
|---|---|
| US entity with 25%+ foreign owner, or foreign-owned disregarded LLC | 5472 (+ pro-forma 1120 for DRE) — see `stage-3-1120F-5472.md` |
| US person owns / acquires / disposes of 10%+ of a foreign corporation (Indian Pvt Ltd is the standard case) | 5471, category determination, and if CFC: 8992 (GILTI), 8993 (§250 deduction, corporations), 1118 / 1116, §962 statement |
| US person owns a foreign disregarded entity or foreign branch (Indian LLP treated as DRE, branch office, or a foreign entity with check-the-box) | 8858 (+ Schedule M) |
| US person in a foreign partnership (Indian LLP or firm not elected as corporation) | 8865, category determination |
| Foreign mutual fund, ETF, ULIP, pooled fund | 8621 per fund, per year |
| Foreign trust, or gift/bequest from a foreign person over threshold | 3520; 3520-A for grantor trusts |
| Foreign financial accounts over threshold | FinCEN 114 (separate filing, separate deadline) and 8938 (with return) — both may apply |
| US-source FDAP paid to a foreign person | 1042, 1042-S, W-8 series on file |
| Partnership with foreign partner and ECI | 8804, 8805, 8813 |
| Transfer of a partnership interest by a foreign person | §1446(f) transferee withholding, 8288-A analogue for partnerships — position note |
| Transfer of property to a foreign corporation (formation of Indian sub, contribution of IP) | 926 |
| Treaty-based position that reduces tax | 8833 |
| Foreign earned income exclusion | 2555 |
| Foreign real property sale by a foreign person | 8288 / 8288-A / 8288-B |

Every "fact present, form absent" is **Critical**. Every "form present, fact
absent" (form filed for a structure that no longer exists) is High — it signals
the determination was carried forward.

## 1. Form 5471

| Check | Plain English |
|---|---|
| Category of filer (1, 2, 3, 4, 5 and sub-categories) re-determined from ownership, acquisition/disposition events, and CFC status | Category drives which schedules print; wrong category = incomplete form |
| Ownership %: direct, indirect, constructive — attribution through family and entities documented | Constructive ownership through a spouse or parent entity is the standard miss |
| Foreign corporation identity: name, address, country, reference ID (consistent year to year), functional currency, tax year | ID mismatch across years breaks IRS matching |
| Schedule A / B: shareholder list, ownership, US shareholder identification | Ties to cap table |
| Schedule C (income statement) and F (balance sheet): in functional currency **and** USD; translation rates documented (average for P&L, year-end for balance sheet); agrees to the foreign entity's audited or management accounts | Must tie to Indian books / audited financials |
| Schedule E: foreign taxes paid / accrued by category; ties to Indian tax computation and challans | Feeds FTC and GILTI high-tax exclusion |
| Schedule G: yes/no questions all answered (cost sharing, base erosion, §267A, hybrid, etc.) | Defaulted answers are findings |
| Schedule H: current E&P computation, adjustments from local GAAP to US tax principles | E&P is the base for everything — not the Indian profit |
| Schedule I: shareholder's income inclusions — Subpart F, §956, §965 residual, GILTI reference | Character |
| Schedule I-1: GILTI inputs — tested income/loss, QBAI, tested interest — ties to 8992 | Tie-out |
| Schedule J: accumulated E&P by PTEP category and non-PTEP — rolls from prior year | PTEP schedule opened in year one and never abandoned; if missing, Critical |
| Schedule M: related-party transactions — ties to Indian TP study / Form 3CEB and to 5472 on the US side if the US entity is also a reporting corporation | Same transaction, both forms, both countries |
| Schedule O: organisation / reorganisation / acquisition / disposition events in the year | Category 3 trigger |
| Schedule P: PTEP by shareholder | Roll |
| Schedule Q: CFC income by group (for FTC) | High-tax exception |
| Schedule R: distributions | Ties to dividends received on the 1040 / 1120 |
| Dormant corporation summary procedure claimed only if every condition is met | Position note |
| Multiple filers: one 5471 with all US shareholders listed, or each files — documented which | Duplicate or missing |

## 2. GILTI, Subpart F, §962 (with the 5471)

| Check | Plain English |
|---|---|
| CFC status confirmed (>50% by US shareholders with attribution) | Threshold |
| Subpart F income by category (foreign personal holding company income — interest, dividends, rents, royalties; foreign base company sales / services) — de minimis and full-inclusion rules applied by calculation layer | Character |
| GILTI: 8992 per shareholder; tested income − tested loss − NDTIR; ties to 5471 Schedule I-1 | Computation layer |
| Corporate shareholder: 8993 §250 deduction; 1118 FTC with the 80% haircut | Deduction |
| Individual shareholder: §962 election modelled — statement attached if made; FTC then available at corporate rates; second-level tax on distribution tracked | Frequently beneficial, frequently missed |
| High-tax exclusion election considered (Indian rate typically exceeds threshold) — annual, consistent across the CFC group | Election |
| PTEP: inclusions increase; distributions reduce; basis adjustments to CFC stock recorded | Roll |
| FTC baskets: GILTI basket separate from general / passive | 1116 / 1118 |
| State: GILTI treatment differs by state — flag for state module | State |

## 3. Form 8858

| Check | Plain English |
|---|---|
| Filed for each foreign DRE and each foreign branch (a foreign branch is a QBU with separate books — an Indian branch office or a liaison office with income qualifies) | Branch, not just DRE |
| Tax owner and direct owner correctly identified; where the DRE is under a CFC, 8858 attaches to the 5471 | Chain |
| Schedule C income statement and F balance sheet in functional currency and USD; ties to Indian books | Tie-out |
| Schedule C-1: §987 gain/loss on remittances — calculation layer | Currency |
| Schedule G questions answered | Defaults |
| Schedule H: current E&P or taxable income | Base |
| Schedule I: foreign branch loss recapture / dual consolidated loss | Position if losses |
| Schedule J: foreign taxes for FTC | Feeds 1116/1118 |
| Schedule M: related-party transactions — ties to TP study | Symmetry |
| Check-the-box (8832) election on file with effective date; India tax classification (LLP / company) noted for hybrid analysis | Hybrid |

## 4. Form 8865

| Check | Plain English |
|---|---|
| Category (1–4) re-determined: control, 10% in a US-controlled partnership, contribution, acquisition / disposition | Category |
| Schedules per category: A, A-1, A-2, B (income), K, K-1s, L, M-1, M-2, N (related-party), O (transfers), P (acquisitions/dispositions) | Completeness |
| Indian LLP: confirm US classification (default partnership unless elected); partners' shares; Indian LLP return and partner tax credits cross-referenced | Classification |
| K-2 / K-3 for the foreign partnership if required | Foreign items |
| Schedule N ties to TP documentation | Symmetry |

## 5. Form 8621 (PFIC)

| Check | Plain English |
|---|---|
| One 8621 per fund, per year, including years with no disposition where a regime election is in place or the filing threshold is met | Per fund |
| Regime: excess distribution (default), QEF (rarely available for Indian funds — statement from fund required), mark-to-market (only if marketable — documented) | Election consistency year to year |
| Excess distribution computation: holding period, allocation to prior years, interest — calculation layer; ties to 1040 line and to Indian capital gains statements | Computation |
| Indian mutual funds, ULIPs, portfolio management schemes, some NPS/insurance products — each tested; a "no PFICs" answer must be supported by the client questionnaire asking the specific question | Under-disclosure |
| Basis, distributions, sale proceeds in USD at transaction-date rates | Currency |
| 8938 listing agrees to 8621 list | Cross-form |

## 6. Forms 3520 / 3520-A

| Check | Plain English |
|---|---|
| Gifts / bequests from a foreign individual or estate above threshold, aggregated by related donors; gifts from foreign entities at the lower threshold | Aggregation |
| Indian family gifts (parents funding a down payment) — the most common miss on Indian-origin 1040s | Ask specifically |
| Foreign trust: grantor / beneficiary status; 3520-A by the trust (or substitute by the owner); Indian PPF / EPF / NPS / HUF positions documented per firm policy — position register | Position |
| Distributions from foreign trusts — default rule if no beneficiary statement | Character |

## 7. FinCEN 114 (FBAR) and Form 8938

| Check | Plain English |
|---|---|
| Account list complete: bank, deposit, NRE/NRO, PPF, demat, brokerage, insurance with cash value, foreign pension where applicable, accounts with signature authority only, joint accounts, accounts held by an owned entity (>50%) | Completeness — signature authority and entity accounts are the misses |
| Maximum value during the year, in USD at the Treasury year-end rate, per account | Rate source |
| FBAR filed separately with FinCEN by its own deadline — acknowledgment in file | Separate filing |
| 8938 thresholds by filing status and residence; assets beyond accounts (foreign stock held directly, foreign partnership interests, foreign pensions, PFICs) listed or cross-referenced to 5471 / 8865 / 8621 | Two regimes, different scope |
| FBAR list ≥ 8938 account list; differences explained | Cross-form |
| Prior unfiled years — streamlined / delinquent procedures position registered; not fixed silently | Partner trigger |

## 8. Forms 1042 / 1042-S and W-8

| Check | Plain English |
|---|---|
| Every US-source payment to a foreign person (dividends, interest, royalties, services performed in the US, rent, management fees to foreign parent) identified from the GL and 5472 Part IV | Completeness |
| W-8BEN / W-8BEN-E / W-8ECI / W-8IMY on file, valid, treaty article and limitation-on-benefits claim completed before the reduced rate is applied | Documentation |
| Withholding rate: 30% or treaty rate (US-India treaty text in corpus) — applied by calculation layer | Rate |
| Deposits made on time; 1042 annual return reconciles to sum of 1042-S; 1042-S furnished to recipients | Reconciliation |
| Services performed outside the US are foreign-source — no withholding but documented; India TDS / GST symmetry | Source |
| Interest to foreign related party: portfolio interest exception not available to 10% owners — withhold | Common miss |

## 9. Forms 8804 / 8805 / 8813 (§1446)

| Check | Plain English |
|---|---|
| Every foreign partner has a W-8 (or W-9 if US); undocumented partner withheld at highest rate | Documentation |
| ECTI allocated to foreign partners agrees to K-1 / K-3 | Tie-out |
| Quarterly 8813 instalments made; 8804 annual with 8805 per partner; 8805 furnished so the partner claims the credit on 1040-NR / 1120-F | Credit trace — frequently dropped |
| Reduced withholding certificates (8804-C) on file if used | Documentation |
| §1446(f): any transfer of a partnership interest by a foreign partner — transferee withholding or exception documented | Transfer |

## 10. Forms 926, 8833, 2555

| Form | Check |
|---|---|
| 926 | Any cash or property contribution by a US person to a foreign corporation above threshold (funding an Indian subsidiary is the standard case); FMV, basis, and gain recognition documented |
| 8833 | Attached whenever a treaty reduces tax or changes residency; article and paragraph from the treaty text in the corpus; consistent with 1042-S rates and 1120-F / 1040-NR positions |
| 2555 | Bona fide residence or physical presence test days documented; housing; no double benefit with FTC on excluded income |

## 11. Cross-form tie-outs (mandatory)

| Tie-out |
|---|
| 5471 Schedule M related-party amounts = 5472 Part IV (if US entity is also a reporting corp) = TP study = Indian Form 3CEB |
| 5471 Schedule C/F = Indian audited / management accounts translated at documented rates |
| 5471 Schedule I-1 = 8992 inputs |
| 8992 inclusion = 1040 / 1120 GILTI line |
| 5471 Schedule R distributions = dividends on the owner's return |
| 8621 fund list ⊆ 8938 asset list; FBAR account list ⊇ 8938 account list |
| 1042 total = Σ 1042-S = withholding claimed on 1040-NR / 1120-F of recipients (where the firm prepares both) |
| 8805 withholding = credit claimed on partner's return |
| Ownership % consistent across 5471, 8865, 8858, 5472, K-1s, cap table, and Indian filings (MGT-7, FC-GPR/ODI forms) |
| 926 contributions = 5471 Schedule O / Indian FC-GPR / ODI Form FC amounts |
