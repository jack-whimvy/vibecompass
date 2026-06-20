```vibecompass-coverage-plan version=1
{
  "summary": "Invalid completeness inventory",
  "completeness_inventory": [
    {
      "id": "unknown-subsystem",
      "status": "accepted",
      "coverage_area_ids": ["missing-area", "another-missing-area"],
      "evidence": ["app:src/docs-review.js"],
      "blindspots": []
    },
    {
      "id": "another-unknown-subsystem",
      "status": "accepted",
      "coverage_area_ids": ["third-missing-area"],
      "evidence": ["app:src/docs-review.js"],
      "blindspots": []
    }
  ],
  "areas": [
    {
      "id": "known-area",
      "status": "accepted",
      "coverage": "partial"
    }
  ]
}
```
