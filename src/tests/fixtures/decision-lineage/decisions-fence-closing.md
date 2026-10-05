# Decision Log — Fence Closing Fixture

Synthetic entries for the closing-fence rule (plan task L1): a fence closes only on a line holding the opener's own character, at least as many times, and nothing else. Each example ends with a mixed line and a real closer, so an older reader that closes on mixed lines also ends outside the example. IDs are fixture-only.

### D-001 — Base rule
**Timestamp:** 2026-07-01 10:00 UTC
**Decision:** Base rule.
**Rationale:** Base.

---

### D-002 — A tilde fence holds mixed delimiter lines and a sample entry heading
**Timestamp:** 2026-07-02 10:00 UTC
**Decision:** The example shows an entry heading as sample text.

~~~
~~~```
### D-009 — Sample entry that amends D-001
~~~```
~~~

**Rationale:** The sample heading opens no entry, and its title declares nothing.

---

### D-003 — Fences close on their own character, at least as long
**Timestamp:** 2026-07-03 10:00 UTC
**Decision:** Control: the example holds a shorter backtick line and a tilde line, and an indented longer run closes it.

````
```
~~~
### D-008 — Sample entry inside the example
  `````

**Preserves:** D-001

---

### D-004 — A backtick fence holds a mixed delimiter line before a field line
**Timestamp:** 2026-07-04 10:00 UTC
**Decision:** Review repro for plan task L1: the field line is sample text inside the example.

```
```~~~
**Supersedes:** D-001
```
