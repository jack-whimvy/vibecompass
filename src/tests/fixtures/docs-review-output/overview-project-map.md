````vibecompass-architecture-doc path=architecture/overview/project-shape.md
---
status: Complete
---

## Description
Project shape with an accepted journey map.

```vibecompass-project-map version=1
{
  "features": [
    {
      "domain": "Product",
      "feature": "Onboarding",
      "is_entry_point": true,
      "summary": "Users connect the project."
    },
    {
      "domain": "Product",
      "feature": "Dashboard",
      "summary": "Users inspect project health."
    }
  ],
  "relationships": [
    {
      "from": { "domain": "Product", "feature": "Onboarding" },
      "to": { "domain": "Product", "feature": "Dashboard" },
      "kind": "navigates_to",
      "label": "After setup, users enter the dashboard."
    }
  ]
}
```
````
