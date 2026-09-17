# Batch checks

One request often falls under several policies: a per-key API limit and a per-IP abuse limit, or a per-user quota and a global one. Checking them one by one is wrong: the first would be consumed even when the second denies. A batch spends all or nothing.

```bash
rcurl -X POST $RL/v1/check/batch -d '{
  "checks": [
    { "policy": "api",   "subject": "key_7f3a" },
    { "policy": "ip",    "subject": "203.0.113.7" },
    { "policy": "heavy", "subject": "key_7f3a", "cost": 5 }
  ]
}'
```

```json
{
  "allowed": false,
  "results": [
    { "policy": "api",   "subject": "key_7f3a",    "allowed": false, "remaining": 12, "retryAfter": 0, "...": "..." },
    { "policy": "ip",    "subject": "203.0.113.7", "allowed": false, "remaining": 0,  "retryAfter": 41, "...": "..." },
    { "policy": "heavy", "subject": "key_7f3a",    "allowed": false, "remaining": 3,  "retryAfter": 0, "...": "..." }
  ]
}
```

- `allowed` is the batch decision. When any check denies, every result reports `allowed: false` and no counter moves; the entry with `retryAfter > 0` (or `blocked: true`) is the one that denied.
- When the batch is allowed, every check is consumed in one transaction.
- Each entry counts as one decision in the statistics of its policy, allowed or denied together with the batch.
- The same `policy` + `subject` pair may appear once per batch (`400 DUPLICATE_CHECK`). At most `MAX_BATCH` (20) entries.
- `"peek": true` applies to the whole batch.

For headers, take the entry with the least `remaining` among allowed results, or the denying entry.
