# Stage 3 — Form 1040-NR

The firm's 1040-NR population: F-1/OPT employees, Indian founders with US-source
income, NRA owners of US LLCs, NRA investors in US real estate or partnerships,
and departing / arriving dual-status individuals.

## 3.1 Stage 0 for 1040-NR — the residency decision is the return

| Check | Plain English |
|---|---|
| Substantial presence test: day count by year (current, 1/3 prior, 1/6 second prior) from passport / I-94 records — calculation layer | Determines 1040 vs 1040-NR |
| Exempt individual days excluded: F, J, M, Q students (5 calendar years), teachers/trainees (2 of 6); 8843 filed for each exempt year | Days |
| Closer-connection exception (8840) considered if 183-day test met but tax home abroad | Exception |
| Treaty tie-breaker (8833) if dual resident | Treaty |
| Dual-status year: first-year election, last-year residency end date, statement attached; income split by period; no standard deduction, restricted filing status | Two returns in one |
| Spouse election to file jointly as residents (§6013(g)/(h)) — deliberate, worldwide income consequence explained in file | Election |
| Departure: sailing permit / 1040-C position; expatriation (8854) if green card / citizen relinquished | Exit |
| Visa, entry date, country of residence, treaty country on Schedule OI — all completed | Required |

## 3.2 Income — ECI vs FDAP, every stream classified

| Stream | Classification check |
|---|---|
| Wages for services in the US | ECI; W-2; FICA exemption for F-1 students in exempt years; treaty exemption (India: none for wages, student article only for maintenance/grants) — `authority: verify` |
| Scholarship / fellowship | Treaty article 21 for Indian students on qualifying grants; 1042-S code |
| Self-employment / consulting performed in the US | ECI; Schedule C; SE tax only if totalisation / treaty position — India has no totalisation agreement |
| Services performed outside the US | Foreign-source — not US-taxable; document where the work was physically performed |
| K-1 from US partnership (ECI) | ECI; 8805 credit; state non-resident return |
| K-1 from foreign-owned US LLC (DRE) | Owner reports LLC's ECI directly on 1040-NR Schedule 1 / C / E; 5472 filed by the LLC |
| US rental real estate | FDAP at 30% on gross unless §871(d) net election made (statement attached) — election is permanent once made |
| Sale of US real property | FIRPTA; 8288-A credit; Schedule D / 8949 |
| US dividends | FDAP; Schedule NEC; 30% or treaty rate (US-India: 25%) with 1042-S credit — `authority: verify` |
| US bank interest | Generally exempt (portfolio / bank deposit interest) — confirm not ECI |
| Capital gains on US stock | Generally not taxed for NRA unless 183+ days in the US (then 30%) — day test |
| Retirement / pension / IRA distributions | FDAP or ECI depending on source; treaty; 1042-S |
| Gambling, prizes | Schedule NEC |
| Indian income (salary, rent, interest, capital gains) | Not reported — NRA is taxed on US-source only; confirm nothing foreign has been entered |

## 3.3 Deductions and credits

| Check | Plain English |
|---|---|
| Standard deduction: not allowed, **except** Indian students / business apprentices under Article 21(2) — statement or 8833 attached; `authority: verify` | Treaty |
| Itemised: only those connected with ECI — state income tax, charitable to US organisations, casualty; no mortgage interest on a foreign home, no medical | Limited |
| Personal exemptions: none post-2017; dependents generally not claimable — Indian treaty position for spouse/children considered under Article 21 for students; `authority: verify` | Limited |
| Child tax credit / education credits: generally not available to NRA; exceptions documented | Eligibility |
| Foreign tax credit: only against ECI that is also foreign-taxed — rare | Rare |
| Moving expenses, student loan interest: restricted | Limited |

## 3.4 Schedules NEC and OI

| Check | Plain English |
|---|---|
| Schedule NEC: each FDAP item by rate column (10% / 15% / 30% / other treaty); 1042-S box amounts agree; treaty article cited | Rate column |
| Schedule OI: country of residence, citizenship, visa type and changes, days present each of three years, prior-year filing history, treaty claims by country/article/amount, expatriation question | Every item completed |
| 8843 attached for exempt individuals | Required |

## 3.5 Withholding, payments, refund

| Check | Plain English |
|---|---|
| W-2 withholding; 1042-S withholding (code, rate, amount); 8805 (§1446); 8288-A (FIRPTA) — each entered as a credit with the form in file | Credit trace |
| Estimated payments per IRS transcript | Payments |
| Refund to a US bank account, or paper cheque to a foreign address — client instruction confirmed; ITIN valid (W-7 attached if applying with the return) | Delivery |

## 3.6 State

Non-resident state return for every state where services were performed or
property / partnership income is sourced; states do not follow the treaty —
treaty-exempt federal income may still be state-taxable. See `stage-3-state.md`.

## 3.7 India-side symmetry (do not fix here — flag for the India team)

- Residential status under Indian law (ROR / RNOR / NR) decided from the same day counts — one chronology, two tests.
- US-source salary of an Indian resident is taxable in India with DTAA credit (Form 67 in India); if the individual is NRA for US and resident for India, the US 1040-NR tax is the creditable amount.
- Schedule FA / foreign asset disclosure in the Indian ITR for US accounts and US LLC ownership.
- US LLC owned by an Indian resident individual = ODI / OPI — run `fema-odi-review`.

## 3.8 Sign-off items

1. Residency decision written down with day counts and visa history.
2. Every income stream classified ECI / FDAP / foreign-source with the reason.
3. Every withholding credit has its form (W-2, 1042-S, 8805, 8288-A) in file.
4. Every treaty claim has 8833 or the required statement, citing the article from the corpus.
5. Schedule OI complete; 8843 attached if exempt individual.
6. State non-resident returns match federal sourcing.
