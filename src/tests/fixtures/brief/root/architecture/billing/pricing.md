---
domain: Billing
feature: Pricing
component: Plan Catalog
status: Complete
repos:
  - app
---

## Description
Plan catalog for the Solo plan price and the Free plan allowance; the current catalog entries follow D-104 and its successors.

## Review metadata
- Evidence: `app:src/lib/catalog.ts`
- Blindspots: synthetic fixture

## Details
Catalog values are read at checkout.

## Retrieval guidance
Load before changing plan prices or catalog entries.

## Next steps
- None.

## Involved files
- `app:src/lib/catalog.ts`
