# ratelimit examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `RATELIMIT_API_KEYS`. Base URL below is `http://localhost:3011`.

| Example | Shows |
|---|---|
| [Policies](policies.md) | Creating a policy with several windows, changing limits, deleting |
| [Checking](checking.md) | The check call, cost, peek, what `remaining` and `retryAfter` mean, the sliding window |
| [Batch checks](batch.md) | Several policies for one request, all-or-nothing |
| [Release](release.md) | Giving units back when the work failed after the check |
| [Overrides and blocks](overrides.md) | Per-subject limits, temporary blocks, expiry |
| [Usage and statistics](usage-and-stats.md) | Looking up a subject, top consumers, hourly allowed/denied, resetting a subject |
| [Middleware integration](middleware.md) | A Fastify hook that checks, sets `RateLimit-*` headers, answers 429 and fails open |
| [API keys and roles](keys-and-roles.md) | check, read, write, readwrite; scoping a key to policies; error codes |
| [Operations](operations.md) | Health, readiness, metrics, environment, housekeeping, PM2, Docker, backups |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export RL=http://localhost:3011
export KEY=<a readwrite secret from RATELIMIT_API_KEYS>
alias rcurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
