---
domain: Sync
feature: Lanes
component: Session Lanes
status: In progress
repos:
  - core
---

## Description
Session lanes let several builder sessions run in parallel against one memory root.

## Review metadata
- Evidence: `core:src/session.js`
- Blindspots: synthetic fixture

## Details
A lane doc can show example documents in fences:

```md
## Description
Fenced example text that is not this document's description.
```

## Retrieval guidance
Load before changing lane selection or lane scratch files.

## Next steps
- None.

## Involved files
- `core:src/session.js`
