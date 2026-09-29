---
domain: Sync
feature: Credentials
component: Credential Store
status: In progress
repos:
  - core
---

## Description
Local credential store for hosted sync tokens: an environment override first, then the per-user store.

## Review metadata
- Evidence: `core:src/credential-store.js`
- Blindspots: synthetic fixture

## Details
Tokens never enter project files.

## Next steps
- Decide whether a keychain backend is worth adding.

## Involved files
- `acme-core/src/credential-store.js`
