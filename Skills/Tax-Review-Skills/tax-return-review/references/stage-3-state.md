# Stage 3 — State and local returns

State review runs after federal is clean, because most state figures start from
federal. Two things the model never does here: it never decides whether a state
return is required (the obligation engine decides, from nexus facts), and it
never applies a rate, threshold, or apportionment formula (Drake's state module
and the calculation layer do). The model checks that what Drake produced matches
the facts and the federal return.

## 3.1 Stage 0 for state — the list must match

| Check | Plain English |
|---|---|
| The obligation engine's list of required state / city returns for this entity and year = the state returns Drake generated | Missing state = Critical; extra state = High (usually a prior-year carry-forward) |
| Nexus facts on file: physical presence (office, inventory, employees incl. remote, contractors), sales by state, payroll by state, property by state, registration / foreign qualification | Economic nexus for sales tax and income tax differ — both recorded |
| Registrations: state tax ID, withholding account, unemployment account, sales tax permit — numbers in file and on the return | Rejections |
| Entity-type treatment per state: some states tax S-corps / partnerships at entity level, some have franchise or gross-receipts taxes regardless of income, some have PTE elections | Federal pass-through ≠ state pass-through |
| Combined / unitary / consolidated filing requirement or election for corporate groups | Group |
| First-year / final-year: initial registration, final return box, withdrawal / dissolution filing | Boxes |

## 3.2 Income tax — starting point and modifications

| Check | Plain English |
|---|---|
| Starting point (federal taxable income, federal ordinary income, or federal AGI) matches the federal return as reviewed — after all federal fixes | Re-run state after every federal change |
| Additions applied per Drake's state module and consistent with prior year: state income tax deducted federally, federal bonus depreciation (decoupled states), §179 excess, related-party interest / intangible expense addbacks, GILTI / Subpart F treatment, municipal interest from other states | Modifications |
| Subtractions: US Treasury interest, dividends received deductions, decoupled depreciation recovery, state NOL (separate schedule and carry-forward) | Modifications |
| State NOL tracked separately from federal — schedule in file | Roll |
| State credits: claimed only with supporting certificate / form in file | Substantiation |
| Estimated payments and extension payments per state account transcript, not per books | Payments |

## 3.3 Apportionment

| Check | Plain English |
|---|---|
| Sales factor: sourcing method per state (market-based vs cost-of-performance for services; destination for goods); total sales across all states = federal gross receipts | Every dollar sourced somewhere |
| Payroll factor: agrees to state unemployment / withholding returns by state; total = federal wages | Tie-out |
| Property factor: owned property at cost, rented property at multiple, by state; total = federal Schedule L property | Tie-out |
| Throwback / throwout rules applied where the state has them | Sourcing |
| Single-sales-factor vs three-factor per state — Drake applies; reviewer confirms the state's method year is correct | Method |
| Apportionment percentages across all states sum near 100% (nowhere-income explained) | Reasonableness |
| Foreign-owned / foreign entities: 1120-F branch income apportioned to states — states do not follow treaty PE thresholds | No treaty |

## 3.4 Pass-through entities (1065 / 1120-S) — state specifics

| Check | Plain English |
|---|---|
| PTE tax election: made / declined deliberately each year; election form filed by the state deadline; PTE credit shown on each owner's state K-1 | Owner-level SALT workaround |
| Composite return for non-resident owners: elected or not; owners included agree to list; owners who opted out have their own non-resident returns | Composite |
| Non-resident owner withholding: computed by Drake, agrees to state schedule, deposits made, credited on owner returns | Credit trace |
| State K-1 / K-1 equivalents: each owner, each state, apportioned share, PTE credit, withholding | Per owner |
| Entity-level taxes on pass-throughs (franchise, margin, gross-receipts, replacement taxes) where the state imposes them | Entity tax |
| Resident state of each owner: entity's state K-1 flows to the owner's resident return with other-state credit | Owner |

## 3.5 Corporations (1120 / 1120-F) — state specifics

| Check | Plain English |
|---|---|
| Franchise / net-worth / capital-based tax computed on the correct base (net worth, capital stock, paid-in capital); base ties to Schedule L | Base |
| Minimum tax applied where income tax is below the floor | Minimum |
| Combined report members and elimination of intercompany transactions | Group |
| Foreign-owned corporations: foreign shareholder information where the state asks; related-party addbacks for payments to foreign parent | Addback |
| Foreign corporations (1120-F): state return where branch has nexus; ECI-only vs worldwide starting point per state | Starting point |

## 3.6 Individuals (1040 / 1040-NR) — state specifics

| Check | Plain English |
|---|---|
| Residency by state: resident / part-year / non-resident from domicile and day-count; move dates match federal address change and W-2 state boxes | Residency |
| Part-year allocation of income by period; non-resident sourcing of wages by workday; convenience-of-employer rule states flagged | Allocation |
| Other-state tax credit on the resident return for tax paid to non-resident states; credit ≤ resident-state tax on that income | Credit |
| W-2 state wages and withholding by state entered; multi-state W-2s split | Entry |
| State treatment of treaty-exempt income (most states do not follow) — federal treaty exclusion added back | No treaty |
| State standard / itemised, exemptions, credits per state module | State rules |
| State does not conform to a federal item (HSA, 529, depreciation, NOL, QBI) — modification applied | Conformity |
| Foreign income / foreign tax credit: states generally do not allow FTC — resident state taxes worldwide income of a resident with no credit for Indian tax | Common surprise for returning Indian residents |

## 3.7 City and local

| Check | Plain English |
|---|---|
| City income / business taxes where the entity or individual has city nexus (large-city business taxes, unincorporated business taxes, local earned income taxes, school district taxes) — obligation engine lists them | Local |
| Local returns start from the state or federal figure as the city prescribes | Starting point |
| Local withholding and registrations for employees by work location | Payroll |

## 3.8 Annual reports, franchise, and non-income filings (obligation engine, not this review)

Confirm the engine shows these as scheduled and does not expect them inside the
Drake return: annual report / statement of information, registered agent, state
franchise tax not computed on the income return, sales and use tax returns,
gross-receipts taxes, business personal property returns, unclaimed property.
If the engine has none of these for a state where the entity is registered, that
is a finding for the engine's owner, not for the preparer.

## 3.9 Cross-checks

| Tie-out |
|---|
| Σ state sales factor numerators ≈ federal gross receipts (nowhere sales explained) |
| Σ state payroll = federal wages = W-3 |
| State starting-point figure = federal figure after all federal fixes |
| State K-1 apportioned income × owner % = owner's state K-1 |
| Non-resident withholding per entity = credit on owner return |
| Other-state credit on resident return = tax per non-resident return |
| State estimated payments = state transcript |

## 3.10 Sign-off items

1. Engine list = Drake state returns generated.
2. State starting point re-run after the last federal change (date-stamped).
3. Apportionment factors tie to federal totals.
4. PTE / composite / withholding decisions recorded, with the election form in file where made.
5. Every state credit has its certificate.
