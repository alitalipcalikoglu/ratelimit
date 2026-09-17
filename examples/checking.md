# Checking

One call per request: "may `subject` spend `cost` units under `policy` right now?" The service answers and, when allowed, records the spend in the same transaction.

```bash
rcurl -X POST $RL/v1/check -d '{ "policy": "api", "subject": "key_7f3a" }'
```

```json
{
  "policy": "api",
  "subject": "key_7f3a",
  "allowed": true,
  "cost": 1,
  "source": "policy",
  "blocked": false,
  "limit": 100,
  "remaining": 99,
  "resetAt": "2026-09-17T10:01:00.000Z",
  "retryAfter": 0,
  "limits": [
    { "window": 60, "limit": 100, "used": 1, "remaining": 99, "allowed": true, "resetAt": "2026-09-17T10:01:00.000Z", "retryAfter": 0 },
    { "window": 86400, "limit": 20000, "used": 1, "remaining": 19999, "allowed": true, "resetAt": "2026-09-18T00:00:00.000Z", "retryAfter": 0 }
  ]
}
```

- `allowed` is the decision. The HTTP status is 200 either way; your code turns `false` into a 429 (or a queue, or a slower path).
- The top-level `limit`, `remaining`, `resetAt`, `retryAfter` describe the most restrictive window: the one with the least room when allowed, the one with the longest wait when denied. Use them for `RateLimit-*` headers.
- `remaining` is what is left after this call. `used` is the sliding estimate before it.
- `retryAfter` is seconds until a request of the same cost fits again; `0` when allowed, `null` when the subject is [blocked](overrides.md).
- `source` is `override` when a per-subject override was applied.

## Denied

```json
{
  "allowed": false, "limit": 100, "remaining": 0, "resetAt": "2026-09-17T10:01:00.000Z", "retryAfter": 23, "...": "..."
}
```

Nothing was consumed. Wait `retryAfter` seconds; the hint accounts for the previous window fading out, so retrying exactly then succeeds unless other requests arrived in between.

## Cost

A heavy operation can spend more than one unit:

```bash
rcurl -X POST $RL/v1/check -d '{ "policy": "api", "subject": "key_7f3a", "cost": 10 }'
```

Every window must have room for the whole cost, otherwise nothing is consumed. A cost larger than a window's limit can never fit and returns `400 COST_TOO_HIGH`. `MAX_COST` (1 000 000) caps a single check.

## Peek

`"peek": true` answers without consuming, for dashboards or for deciding whether to show a button:

```bash
rcurl -X POST $RL/v1/check -d '{ "policy": "export", "subject": "user_42", "peek": true }'
```

Peeks are not counted in statistics.

## The sliding window

Each window keeps two counters per subject: the current fixed window and the previous one. Usage is `previous × (share of the previous window still inside the trailing window) + current`. At 10:00:20 with a 60 s window, 40/60 of the previous minute still counts. Two integers per window, no request log, and no burst of two full windows around a boundary as with plain fixed windows. The estimate assumes the previous window's requests were spread evenly; that is the trade-off for its size. Usage in a window ends at most one window length after the last request.

## Idempotency and retries

A check is not idempotent: sending it twice spends twice. If your client retries the HTTP call on a timeout, spend once and, if the second answer says denied while the first may have gone through, prefer letting the request pass over double-charging, or use a [release](release.md) when you learn the truth.
