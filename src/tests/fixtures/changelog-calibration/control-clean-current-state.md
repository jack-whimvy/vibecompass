---
domain: Product
feature: Calibration
component: Clean Current State
status: In progress
repo: app
---

## Description
Sanitized calibration fixture patterned on a real dogfood doc shape.

## Review metadata
- Evidence: `app:src/calibration/clean-current-state.ts`
- Blindspots: None identified for this fixture.

## Details
Plain current-state contract prose with an artifact-name date in
inline code: `retired-2026-07-08/` and `2026-07-11_w4_sweep.sql`.

```md
Updated 2026-01-01 (fenced example, must be masked):
```

## Retrieval guidance
- Use only in changelog-detector calibration tests.
- It does not describe runtime behavior.

## Next steps
- None.

## Involved files
- `app:src/calibration/clean-current-state.ts`
