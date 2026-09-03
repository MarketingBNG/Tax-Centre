# Stage 3 — India-side symmetry (ODI / FEMA, TP, TDS, GST, Indian ITR)

The US return is one side of a transaction that also exists in Indian records.
This module does not prepare or review the Indian filings — that is the India
team, using `fema-odi-review`, the TP skill, and Indian compliance SOPs. It checks
that what the US return says is the **same fact** the India side has reported or
will report. Divergence is either a defect or a documented position — never
left unlabelled.

The model never states an RBI limit, FEMA timeline, TDS rate, or GST treatment
from memory. It flags the transaction and names the Indian filing that must
carry the matching figure.

## A. Ownership and investment — ODI / OPI / FDI

| US fact | Indian mirror that must exist | Register if missing |
|---|---|---|
| Indian company or resident individual owns a US LLC / Inc (5472 Part II, 1120 Schedule K q.7, K-1 owner, 1040-NR DRE owner) | ODI (control / 10%+) or OPI: UIN, Form FC, evidence of investment, APR annually; FLA return; for individuals LRS utilisation and Form FC | Critical client-level open item — not a US return item, but the review does not close without it logged and assigned |
| US entity's opening capital / contributions in the year (5472 Part IV/V, M-2 contributions, 926) | Amount, date and route of each remittance from India — Form A2 / LRS / ODI FC filing; amounts agree in USD/INR at the remittance-date rate | Mismatch → High |
| US entity's distributions / dividends to Indian owner (M-2, K-1 box 19, 1042-S) | Repatriation reported in APR; dividend income in the owner's Indian ITR with DTAA credit (Form 67); Indian TCS/TDS if any | Mismatch → High |
| Loan from Indian owner to US entity (5472 Part IV, Schedule L) | Financial commitment under ODI (loans count); APR | Missing → Critical |
| Guarantee by Indian parent for US entity's debt | Financial commitment under ODI | Missing → Critical |
| US entity holds shares in an Indian company (5471, 8858, 8865 on the US side) | FDI reporting in India: FC-GPR / FC-TRS, FLA; round-tripping analysis if the Indian owner sits above the US entity | Missing → Critical; round-tripping unexamined → partner trigger |
| US entity disposed of / wrote off Indian or foreign investment | Disinvestment reporting, repatriation of proceeds | Missing → High |
| Step-down subsidiary under the US entity | Layering / step-down reporting on the Indian side | Missing → High |

## B. Transactions — transfer pricing, TDS, GST

| US fact | Indian mirror | Check |
|---|---|---|
| Payments from US entity to Indian affiliate for services / software / development (5472 Part IV; 1042 analysis; expense on return) | Indian affiliate's export invoices; Form 3CEB and TP study (arm's length method and margin); GST export / LUT; FIRC / e-BRC; SOFTEX where applicable | Amounts agree by category and total; method consistent with any US TP position |
| Payments from Indian affiliate to US entity for services / royalty / interest (income on 1120 / 1065; 5471 Schedule M if CFC) | Indian TDS under DTAA (Form 16A / 26AS), Form 15CA/CB; GST on import of services (RCM); Form 3CEB | US return income = Indian payer's booked expense; Indian TDS = FTC claimed on the US return (1118 / 1116) |
| Management fees / cost allocations between parent and sub | TP study both sides; the same allocation key | One key, both countries |
| Intercompany loan interest | §163(j) on the US side; TDS on interest and thin-cap / interest limitation on the Indian side; ODI financial commitment | Rate consistent with both TP files |
| Reimbursements (Indian affiliate pays US costs or vice versa) | Cost-to-cost with support; GST position | Not silently netted |
| Indian employees of the US entity / secondees | PE risk for the US entity in India; Indian payroll / EPF / TDS; US payroll for US-resident staff | Payroll split by country = W-3 + Indian Form 24Q |

## C. Individuals — Indian ITR mirror

| US fact | Indian mirror |
|---|---|
| US-resident individual (1040) with Indian income (Schedule B, E, 1116) | Indian ITR as NR / RNOR: TDS on NRO interest, rent, capital gains; Form 26AS / AIS totals = amounts reported on the 1040 in USD at documented rates |
| Indian tax credited on 1116 | Indian tax actually paid (challan / 26AS), same year, same income |
| 1040 FBAR / 8938 accounts | Same accounts appear consistently (NRE / NRO status matches residency claimed in India) |
| 1040-NR Indian resident with US income | Indian ITR reports worldwide income incl. US salary / dividends; DTAA credit via Form 67 = US tax per 1040-NR; Schedule FA lists US accounts, US LLC / Inc holdings, US property |
| 5471 / 8621 holdings | Indian ITR Schedule FA (for Indian residents) or Indian capital gains reporting on fund redemptions |
| Gift from Indian parents (3520) | Indian gift tax exemption for relatives — no Indian filing, but Form 15CA/CB on remittance in file |
| Residency: US day count | Indian residency test (182 / 60+365 days) from the same chronology — status on both returns consistent with one set of dates |

## D. Reporting timeline — reconstruct, do not assume

For each US–India owner link, the file holds a chronology:

| Date | Event | Amount | Route | India reporting required | Done | US reporting | Done | Gap |
|---|---|---|---|---|---|---|---|---|

Where the chronology is missing, the register creates a client-level item owned
by the India team lead, with the US return flagged "release does not clear the
India obligation". Unreported historic ODI is the standard client situation; it
is never resolved silently inside a US return.

## E. Sign-off items

1. Every foreign owner / foreign subsidiary link on the US return has a named Indian filing in the chronology, or an open item with an owner.
2. Every related-party amount on 5472 / 5471 Schedule M / 8858 Schedule M / 8865 Schedule N has a matching Form 3CEB / TP study figure, or a documented reason.
3. Every FTC claimed on the US side has an Indian tax payment document.
4. Residency status is consistent across the US and Indian returns from one chronology.
5. Round-tripping question answered in writing for any structure with Indian ownership above and below the US entity.
