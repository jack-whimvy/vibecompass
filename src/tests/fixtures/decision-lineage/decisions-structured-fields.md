# Decision Log — Structured Lineage Fixture

### D-020 — Base contract A
**Timestamp:** 2026-05-01 10:00 UTC
**Decision:** Contract A.
**Rationale:** Base.

---

### D-021 — Base contract B
**Timestamp:** 2026-05-02 10:00 UTC
**Decision:** Contract B.
**Rationale:** Base.

---

### D-022 — Base contract C
**Timestamp:** 2026-05-03 10:00 UTC
**Decision:** Contract C.
**Rationale:** Base.

---

### D-023 — Base contract D
**Timestamp:** 2026-05-04 10:00 UTC
**Decision:** Contract D.
**Rationale:** Base.

---

### D-030 — Structured lineage fields
**Timestamp:** 2026-06-01 10:00 UTC
**Decision:** Replace contracts A and B.
**Supersedes:** D-020
**Partially supersedes:** D-021 — the launch allowance
**Amends:** D-022 — reporting cadence; D-023
**Preserves:** D-021–D-023 — audit trail
**Impact on prior decisions:** Supersedes D-022's reporting cadence. Preserves D-020.
**Rationale:** Exercises every structured field.

---

### D-031 — Structured none and invalid items
**Timestamp:** 2026-06-02 10:00 UTC
**Decision:** Clarify contract C.
**Supersedes:** none
**Amends:** part of D-022; D-12 — typo
**Preserves:** D-023 — reporting
**Impact on prior decisions:** Supersedes D-021 in full.
**Rationale:** Invalid structured items are diagnostics, never relations.
