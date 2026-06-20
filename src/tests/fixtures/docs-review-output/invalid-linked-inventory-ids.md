```vibecompass-coverage-plan version=1
{
  "summary": "Invalid linked inventory ids",
  "topology": "single-repo",
  "taxonomy": {
    "primary_axis": "domain-first",
    "rationale": "Fixture validates area-to-inventory references."
  },
  "completeness_inventory": [
    {
      "id": "known-inventory",
      "kind": "feature",
      "label": "Known inventory",
      "status": "accepted",
      "coverage_area_ids": ["known-area"],
      "evidence": ["app:src/index.ts"],
      "blindspots": []
    }
  ],
  "areas": [
    {
      "id": "known-area",
      "domain": "Platform",
      "feature": "Coverage Plan",
      "component": "Invalid Links",
      "status": "accepted",
      "coverage": "partial",
      "proposed_path": "architecture/platform/coverage-plan/invalid-links.md",
      "linked_inventory_ids": ["known-inventory", "missing-inventory"],
      "anchor_action": "new",
      "evidence": ["app:src/index.ts"],
      "blindspots": []
    },
    {
      "id": "second-area",
      "domain": "Platform",
      "feature": "Coverage Plan",
      "component": "Second Invalid Link",
      "status": "missing",
      "coverage": "missing",
      "linked_inventory_ids": ["another-missing-inventory"],
      "anchor_action": "new",
      "evidence": [],
      "blindspots": ["Exercises aggregate linked inventory validation."]
    }
  ]
}
```
