# Cross-cutting decisions

### D-100 — Free plan uses credit balances
**Timestamp:** 2026-01-01 10:00 UTC
**Decision:** The Free plan grants a monthly credit balance that hosted refresh runs draw down, with top-ups sold separately.
**Rationale:** Credits were the first pricing idea.

---

### D-101 — Hosted refresh runs are metered per account
**Timestamp:** 2026-01-02 10:00 UTC
**Decision:** Every hosted refresh run is metered against the account's allowance for the current period, and a refused run returns a typed denial with the reset time.
**Rationale:** Metering keeps hosted cost bounded.

---

### D-102 — Metering windows follow the paid period
**Timestamp:** 2026-01-03 10:00 UTC
**Decision:** Paid accounts meter hosted refresh runs over the paid invoice period rather than the calendar month.
**Amends:** D-101 — the metering window
**Impact on prior decisions:** Amends D-101's metering window; the rest of D-101 is unchanged.
**Rationale:** Invoices define paid periods.

---

### D-103 — Free plan uses literal run allowances
**Timestamp:** 2026-01-04 10:00 UTC
**Decision:** The Free plan grants three literal hosted refresh runs per month instead of a credit balance.
**Partially supersedes:** D-100 — the credit balance
**Impact on prior decisions:** Partially supersedes D-100: credit balances end, while the monthly Free grant stays.
**Rationale:** Literal runs are easier to explain.

---

### D-105 — Denial messages name the reset time
**Timestamp:** 2026-01-06 10:00 UTC
**Decision:** A refused hosted refresh run shows the reset time and the next step in plain words.
**Impact on prior decisions:** Refines D-101's denial shape with user-facing wording.
**Rationale:** People need to know when runs come back.
