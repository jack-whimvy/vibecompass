```vibecompass-coverage-plan version=1
{
  "summary": "Accepted coverage plan",
  "areas": [
    {
      "id": "platform-docs-review",
      "domain": "Platform",
      "feature": "Docs Review",
      "component": "Local Artifacts",
      "status": "accepted",
      "coverage": "partial",
      "proposed_path": "architecture/platform/docs-review/local-artifacts.md",
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
      "evidence": [],
      "blindspots": ["Deferred to sync-agents audit"]
    }
  ]
}
```
