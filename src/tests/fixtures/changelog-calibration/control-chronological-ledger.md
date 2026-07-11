---
domain: Product
feature: Calibration
component: Chronological Ledger
status: In progress
repo: app
content_mode: chronological-ledger
---

## Description
Sanitized calibration fixture patterned on a real dogfood doc shape.

## Review metadata
- Evidence: `app:src/calibration/chronological-ledger.ts`
- Blindspots: None identified for this fixture.

## Details
Intentionally dated ledger content.

## Audit deepening — 2026-07-07 (verified)
Both envs at migration 131; diffs are trustworthy.

## Retrieval guidance
- Use only in changelog-detector calibration tests.
- It does not describe runtime behavior.

## Next steps
- None.

## Involved files
- `app:src/calibration/chronological-ledger.ts`
