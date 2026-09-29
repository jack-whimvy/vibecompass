# Decision Log — Fixture Domain

Synthetic entries covering the prose lineage forms. IDs are fixture-only.

### D-009 — Original reporting cadence
**Timestamp:** 2025-12-31 10:00 UTC
**Decision:** Reports run weekly.
**Rationale:** Enough for launch.

---

### D-010 — Original storage contract
**Timestamp:** 2026-01-01 10:00 UTC
**Decision:** Projects store one repository each.
**Rationale:** Simplest first cut.

---

### D-011 — Original billing contract
**Timestamp:** 2026-01-02 10:00 UTC
**Decision:** Free tier gets 50 events; Pro is unlimited.
**Rationale:** Launch pricing.

---

### D-012 — Original onboarding spine
**Timestamp:** 2026-01-03 10:00 UTC
**Decision:** Onboarding is one linear seven-step flow.
**Rationale:** Easy to build.

---

### D-013 — Original index maintenance
**Timestamp:** 2026-01-04 10:00 UTC
**Decision:** The decision index is maintained by hand.
**Rationale:** No generator yet.

---

### D-014 — Original local posture
**Timestamp:** 2026-01-05 10:00 UTC
**Decision:** The local package is free and hosting is paid-only.
**Rationale:** Clear split.

---

### D-015 — Multi-repository projects (replaces D-010 single-repo constraint)
**Timestamp:** 2026-02-01 10:00 UTC
**Decision:** D-010 ("one project = one repository") is superseded for implementation but kept for historical reference. D-011 is superseded. Supersedes D-012's single seven-step spine for the hosted app.
**Impact on prior decisions:** Supersedes D-013 in full. Partially supersedes D-014's paid-only framing by adding a free hosted tier, while preserving free local execution. This supersedes the manual-maintenance portion of D-013 without removing the index itself.
**Rationale:** The old README said "Supersedes D-009 in full", which was never true; `supersedes D-008` is a code sample.

> Supersedes D-007 — a quoted proposal that was never adopted.

---

### D-016 — Hosted pricing refresh
**Timestamp:** 2026-03-01 10:00 UTC
**Decision:** Amends D-011's event allowance; D-012 is narrowly amended to allow a back step. Third narrow amendment to D-014's hosting clause.
**Impact on prior decisions:** Preserves D-010, D-013, and D-015's multi-repository capability. Everything else in D-011 stands. D-012's safety checks remain valid for hosted setup, but its step graph becomes branch-aware. Leaves D-014 local posture intact. No contract change to the storage model (D-010/D-015). Offering caps do not reverse D-015's multi-repository capability. Refines D-009's reporting cadence. A later decision may supersede D-009 once teams ship.
**Rationale:** Keeps D-014 authority. Local and free under D-014 as partially superseded by D-015, and D-011.

---

### D-017 — Forward and malformed references
**Timestamp:** 2026-04-01 10:00 UTC
**Decision:** Supersedes D-018's draft wording. D-12 and D-0016 are typos; `D-011-founder-ack` is an identifier, not a reference.
**Impact on prior decisions:** Partially supersedes and refines D-016: the pricing clause changes. Preserves D-010 (storage; unchanged for now), D-011 (billing: the base tier), and D-013's generator-free period. D-014–D-016 remain intact.
**Rationale:** Builds on D-015.

---

### D-018 — Later entry referenced forward
**Timestamp:** 2026-04-02 10:00 UTC
**Decision:** Draft wording for a later entry.
**Rationale:** Exists so D-017's forward reference resolves.
