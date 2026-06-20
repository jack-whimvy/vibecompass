```vibecompass-coverage-plan version=1
{
  "summary": "Accepted coverage plan",
  "topology": "single-repo",
  "taxonomy": {
    "primary_axis": "domain-first",
    "rationale": "Fixture keeps platform docs grouped by product domain."
  },
  "completeness_inventory": [
    {
      "id": "docs-review-local-artifacts",
      "repo_id": "app",
      "kind": "feature",
      "label": "Local docs-review artifacts",
      "confidence": "high",
      "status": "accepted",
      "coverage_area_ids": ["platform-docs-review"],
      "evidence": ["app:src/docs-review.js"],
      "blindspots": []
    },
    {
      "id": "agent-file-audit",
      "repo_id": "app",
      "kind": "feature",
      "label": "Agent file audit",
      "confidence": "medium",
      "status": "missing",
      "coverage_area_ids": ["agent-audit"],
      "evidence": [],
      "blindspots": ["Deferred to sync-agents audit"]
    }
  ],
  "areas": [
    {
      "id": "platform-docs-review",
      "domain": "Platform",
      "feature": "Docs Review",
      "component": "Local Artifacts",
      "status": "accepted",
      "coverage": "partial",
      "proposed_path": "architecture/platform/docs-review/local-artifacts.md",
      "linked_inventory_ids": ["docs-review-local-artifacts"],
      "anchor_action": "update",
      "anchor_paths": ["architecture/platform/docs-review/local-artifacts.md"],
      "anchor_reason": "Existing docs-review local artifacts doc remains the right identity.",
      "evidence": ["app:src/docs-review.js"],
      "blindspots": ["Hosted parser parity deferred"]
    },
    {
      "id": "agent-audit",
      "domain": "Platform",
      "feature": "Agent Files",
      "component": "Audit",
      "status": "missing",
      "coverage": "missing",
      "linked_inventory_ids": ["agent-file-audit"],
      "anchor_action": "new",
      "anchor_reason": "No prior agent audit area exists in the fixture.",
      "evidence": [],
      "blindspots": ["Deferred to sync-agents audit"]
    }
  ]
}
```
