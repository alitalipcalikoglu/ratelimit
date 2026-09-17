# ratelimit

Central rate limits and quotas for every service: named policies with several windows (100 per minute and 20 000 per day), per-subject overrides and blocks, one atomic check per request or per group of policies, a release for work that failed, usage lookups, top consumers and hourly statistics. Sliding-window counters in SQLite, no external store. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set RATELIMIT_API_KEYS
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-ratelimit .
docker run -p 3011:3011 -v ratelimit-data:/data --env-file .env atc-ratelimit
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A policy** (`api`, `login`, `sms`) is a list of windows: at most `limit` units per `window` seconds. A check passes only when every window has room for the cost; then every window is charged, in one transaction. Denied checks consume nothing.
- **A subject** is any string the caller chooses: an API key id, a user id, an IP, a hashed phone number. The service stores it as given.
- **A check** answers `allowed`, plus `limit`, `remaining`, `resetAt` and `retryAfter` for the most restrictive window and the state of every window. `cost` charges more than one unit; `peek` answers without charging. A **batch** checks several policies all-or-nothing. A **release** gives units back after work that failed.
- **An override** replaces the policy's windows for one subject (a partner's larger quota, a smaller plan) and can expire; a limit of `0` blocks the subject.
- **Sliding window**: two counters per subject and window, current and previous fixed window, weighted by overlap. No request log, no double burst at window boundaries; `retryAfter` accounts for the decay.
- **Statistics**: allowed and denied per policy per hour, kept `STATS_RETENTION_DAYS`; top consumers per window; one subject's usage.
- **Keys** are `id:secret[:role[:policies]]` with roles `check` (checks only), `read`, `write`, `readwrite`; a policy scope hides and protects every other policy.

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready` | none | Liveness; readiness (database, cached 10 s). |
| POST | `/v1/check` | check | `{ policy, subject, cost?, peek? }` → decision. |
| POST | `/v1/check/batch` | check | `{ checks: [{ policy, subject, cost? }], peek? }` → `{ allowed, results }`, all-or-nothing. |
| POST | `/v1/release` | check | `{ policy, subject, cost? }` gives units back → state. |
| POST | `/v1/policies` | write | `{ name, description?, limits }` → `201 { policy }`. |
| GET | `/v1/policies`, `/v1/policies/:name` | read | Visible policies with overrides, active subjects and 24 h totals; one policy. |
| PATCH / DELETE | `/v1/policies/:name` | write | `{ description?, limits? }`; delete with overrides, counters and statistics. |
| GET | `/v1/policies/:name/stats` | read | `hours` (default 24, up to 720) → hourly `{ allowed, denied }` series. |
| GET | `/v1/policies/:name/top` | read | `window` (default shortest), `limit` → subjects by current usage. |
| GET | `/v1/policies/:name/overrides` | read | Overrides, newest first (`limit`, `offset`). |
| PUT / DELETE | `/v1/policies/:name/overrides/:subject` | write | `{ limits, note?, expiresAt? }` replaces; delete. |
| GET | `/v1/policies/:name/subjects/:subject` | read | `{ usage, override }` without charging. |
| DELETE | `/v1/policies/:name/subjects/:subject/usage` | write | Forget the subject's counters → `{ removed }`. |
| GET | `/v1/stats` | read | Totals and per-policy 24 h numbers. |
| GET | `/metrics` | read | Prometheus text: policies, decisions since start, counters, database size, uptime. |

Examples for every feature, with requests and responses: [examples/README.md](examples/README.md).

## Configuration

Environment only; see [.env.example](.env.example). Required: `RATELIMIT_API_KEYS`. Notable: `MAX_LIMITS` (windows per policy), `MAX_WINDOW_SEC`, `MAX_COST`, `MAX_BATCH`, `CLEANUP_INTERVAL_SEC`, `STATS_RETENTION_DAYS`, `RATE_LIMIT_MAX` (the service's own per-key limit), `TRUST_PROXY`, `TLS_CERT_PATH` / `TLS_KEY_PATH`.

## Layout

```
src/
  config.js                 Config.fromEnv, key parsing (roles, policy scopes)
  db.js                     SQLite connection, migrations, transactions
  application.js            composition root, lifecycle, cleanup worker
  worker.js                 CleanupWorker: stale counters, expired overrides, old statistics
  domain/limits.js          limit list validation
  domain/sliding-window.js  the estimate, remaining and retry hints
  domain/rate-limit-service.js  policies, overrides, checks, batches, releases, usage, top, stats
  store/                    PolicyStore, OverrideStore, CounterStore (counters + hourly decisions)
  http/rate-limit-api.js    Fastify routes, error mapping, probes, metrics
  http/api-key-auth.js      constant-time bearer auth, roles, policy scope
test/                       node:test suites (config, domain, service, API, TLS)
examples/                   one walkthrough per feature
```

## Out of scope

- Distributed counters across several instances of this service: one process owns one database. Split policies across instances instead.
- Token-bucket or leaky-bucket shaping. The sliding window covers limits and quotas; smoothing at sub-second granularity belongs in the caller.
- Enforcement. The service decides; callers (or the gateway) answer 429. See [examples/middleware.md](examples/middleware.md).

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## License

MIT, Ali Talip CALIKOGLU.
