---
domain: Billing
feature: Ledger
component: Run Ledger
status: In progress
repos:
  - app
---

## Description
Run ledger for hosted refresh runs. Each account has a metered allowance of refresh runs per period under D-101; a refused refresh returns a typed denial with the reset time.

## Review metadata
- Evidence: `app:src/lib/entitlements.ts`
- Retrieval scope: load before changing refresh-run metering or denial messages
- Blindspots: synthetic fixture

## Details
Accepted runs stay consumed. The ledger records every accepted run.

## Retrieval guidance
Load before changing entitlement checks, run metering, or denial semantics for hosted refresh runs.

## Next steps
- None.

## Involved files
- `acme-app/src/lib/entitlements.ts`
- `acme-app/src/lib/billing/`
