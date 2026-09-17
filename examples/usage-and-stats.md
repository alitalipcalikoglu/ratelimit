# Usage and statistics

## One subject

```bash
rcurl $RL/v1/policies/api/subjects/key_7f3a
```

```json
{
  "usage": {
    "policy": "api", "subject": "key_7f3a", "allowed": true, "cost": 0, "source": "policy", "blocked": false,
    "limit": 100, "remaining": 37, "resetAt": "2026-09-17T10:01:00.000Z", "retryAfter": 0,
    "limits": [ { "window": 60, "limit": 100, "used": 63, "remaining": 37, "...": "..." }, { "window": 86400, "limit": 20000, "used": 4120, "remaining": 15880, "...": "..." } ]
  },
  "override": null
}
```

A read with cost 0: `remaining` is what is left right now. `override` is the subject's override row when one exists, expired or not.

## Top consumers

```bash
rcurl "$RL/v1/policies/api/top?window=60&limit=10"
```

```json
{ "window": 60, "limit": 100, "items": [ { "subject": "key_7f3a", "used": 63.5 }, { "subject": "key_09c1", "used": 41 } ] }
```

`window` must be one of the policy's windows (default: the shortest). `used` is the sliding estimate at the time of the call, so fractions appear.

## Hourly statistics

```bash
rcurl "$RL/v1/policies/api/stats?hours=24"
```

```json
{
  "hours": 24, "allowed": 48210, "denied": 1330,
  "series": [ { "hour": "2026-09-16T11:00:00.000Z", "allowed": 1900, "denied": 12 }, "..." ]
}
```

Every consuming check (not peeks) adds one to its hour. Batches count once per entry. `hours` goes up to 720 (30 days, the default `STATS_RETENTION_DAYS`). `GET /v1/stats` gives the last 24 hours for every policy the key can see.

## Reset a subject

```bash
rcurl -X DELETE $RL/v1/policies/api/subjects/key_7f3a/usage
```

```json
{ "removed": 2 }
```

Drops every counter of the subject in that policy, so the next check starts from zero. Statistics are not touched. Use it after a support case, or after a block was lifted and the subject should start clean.
