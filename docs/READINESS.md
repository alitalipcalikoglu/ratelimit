# `ratelimit` readiness contract

## Purpose
`ratelimit` lets the rest of the platform enforce shared rate limits and quotas without each
service reinventing counters: named policies with several sliding-time windows, per-subject
overrides (larger quotas or hard blocks), one atomic check-and-consume per request or per batch of
policies, a release for work that failed after the check succeeded, usage lookups, top-consumer
listings and hourly allow/deny statistics. It decides; enforcement (answering `429`) is left to the
caller or the gateway.

## Dependencies
- `audit` (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither. Same mechanism as `flags` and
  `shortlink` — `src/net/audit-client.js` is byte-identical across all three (verified with `diff`).
  Unset: writes still succeed. Set: write events (policy/override create, update, delete, subject
  reset) are buffered in memory and flushed on a background 2s timer, never on the request path —
  an unreachable or slow audit service never slows down or fails a check, release, or management
  call. Buffered-and-unflushed events are lost on an ungraceful restart.

No other service or external system is called by `ratelimit`.

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), WAL journal mode, `synchronous =
NORMAL`, `busy_timeout = 5000`, foreign keys on. File location: `DB_PATH`, default
`./data/ratelimit.db` (Docker: `/data/ratelimit.db`).

Schema (one migration block, `Database.MIGRATIONS[0]`):
- `policies` — `name` (PK), `description`, `limits` (JSON array of `{window, limit}`),
  `created_by`, `created_at`, `updated_at`.
- `overrides` — per-(policy, subject) replacement limits: `policy` (FK, `ON DELETE CASCADE`),
  `subject`, `limits` (JSON), `note`, `expires_at` (nullable), `created_by`, `created_at`,
  `updated_at`; PK `(policy, subject)`. A `limits` entry with `limit: 0` blocks the subject
  entirely.
- `counters` — fixed-window counts (`WITHOUT ROWID`): `policy`, `subject`, `window` (seconds),
  `window_start` (ms), `count`; PK `(policy, subject, window, window_start)`; index
  `counters_top(policy, window, window_start, count DESC)`. The sliding-window estimate is derived
  from exactly two rows per (policy, subject, window): the current fixed window and the one before
  it, weighted by overlap (`SlidingWindow`, see below) — there is no per-request log.
- `decisions` — hourly allow/deny totals per policy (`WITHOUT ROWID`): `policy`, `hour_start`,
  `allowed`, `denied`; PK `(policy, hour_start)`. This is the durable source for
  `GET /v1/policies/:name/stats` and `GET /v1/stats`.

Migration mechanism: identical pattern to `flags`/`shortlink` — `Database.MIGRATIONS` array gated by
`PRAGMA user_version`, each block in its own transaction. Fresh install and "upgrade from nothing"
are the same today (one migration). No down-migration mechanism.

## Health endpoint
`GET /health` returns `{ status: 'ok' }` unconditionally, no I/O, cannot be slow or fail while the
process event loop is otherwise alive. Logged at `warn`.

## Readiness endpoint
`GET /ready` calls `this.db.ping()` (`SELECT 1`), cached for `RateLimitApi.READY_CACHE_MS =
10_000`ms — same mechanism as `flags`/`shortlink`. Read-only, no mutation, no discarded work, safe
to poll at any interval.

## Graceful shutdown
`SIGTERM`/`SIGINT` → `Application.shutdown(reason)` (idempotent guard). Order: stop the
`CleanupWorker` (`this.worker.stop()`) → `await this.app.close()` (drain in-flight HTTP requests,
including in-progress checks) → `await this.audit.close()` (stop timer, final flush) →
`this.db.close()`. A `30_000`ms unref'd force-exit timer runs in parallel. `unhandledRejection`
routes through the same graceful path; `uncaughtException` calls `process.exit(1)` immediately,
skipping drain and final audit flush. PM2 `kill_timeout: 35000`ms — 5s above the internal 30s
force-exit, same numbers and comment as `flags`/`shortlink`.

## Resource limits
- `BODY_LIMIT` (env, default `65_536` bytes).
- `MAX_LIMITS` (env, default `5`, range 1–20) — windows per policy.
- `MAX_WINDOW_SEC` (env, default `2_592_000` = 30 days) — longest allowed window.
- `MAX_COST` (env, default `1_000_000`) — largest `cost` one check/release may use.
- `MAX_BATCH` (env, default `20`, range 1–100) — checks per `/v1/check/batch` call.
- `RATE_LIMIT_MAX` (env, default `6_000`) — requests per API key per minute against this service's
  own `/v1/*` (the service rate-limits itself the same way `flags`/`shortlink` do).
- `max_memory_restart: '300M'` in `ecosystem.config.cjs`.
- No explicit page-size cap is enforced server-side for `/v1/policies/:name/overrides` beyond the
  caller-supplied `limit`/`offset` (default `limit=50`, `offset=0`, no documented server-side max).

## Timeouts
- Audit outbound call: `timeoutMs = 5_000` default, unchanged by `Application`.
- Shutdown force-exit: `30_000`ms, hard-coded.
- PM2 `listen_timeout: 10000`ms.
- No outward per-request timeout beyond the audit client's — `ratelimit` never calls another
  service synchronously in the request path; every check/release/usage/stats operation is a local
  SQLite transaction.

## Retry policy
Only the audit forwarding path retries, off the request path, on a background timer. Identical
numbers to `flags`/`shortlink` (byte-identical `AuditClient`): `MAX_ATTEMPTS = 6`, backoff `min(30_000,
500 * 2 ** attempt)`ms, no jitter; non-429 4xx drops the batch permanently; 429/5xx/network
error/timeout keeps it buffered for the next `flushMs = 2_000`ms tick once all attempts in the
current call are exhausted. There is no retry logic anywhere else in this service — `checkMany` and
`release` are single-shot SQLite transactions with no internal retry (SQLite's own `busy_timeout =
5000` is the only built-in wait-and-retry, handled inside `node:sqlite` itself, not application
code).

## Idempotency
- `POST /v1/policies` (create) is **not** idempotent: repeating it with the same `name` fails `409
  POLICY_EXISTS`.
- `PATCH /v1/policies/:name` is idempotent in result for a fixed patch.
- `DELETE /v1/policies/:name` is **not** safe to repeat: `removePolicy` calls `this.policies.require(name)`
  first, which throws `404 POLICY_NOT_FOUND` once the policy is already gone.
- `PUT /v1/policies/:name/overrides/:subject` (`setOverride`) **is** idempotent: it's an upsert
  (`ON CONFLICT (policy, subject) DO UPDATE`) keyed on the natural `(policy, subject)` pair, so
  repeating the same body yields the same end state with no error.
- `DELETE .../overrides/:subject` is **not** safe to repeat: `removeOverride` throws `404
  OVERRIDE_NOT_FOUND` if nothing was deleted.
- `DELETE .../subjects/:subject/usage` (`resetUsage`) **is** safe to repeat: it's a `DELETE FROM
  counters WHERE policy = ? AND subject = ?`, and a repeat simply deletes zero rows (`removed: 0`)
  rather than erroring.
- **`POST /v1/check` and `/v1/check/batch` are never idempotent by design** — each successful check
  consumes quota; retrying a check that already succeeded consumes it again. A caller must not blindly
  retry a check whose response was lost in transit, since it cannot tell from the retry alone whether
  the original attempt was already charged.
- **`POST /v1/release` is idempotent only in the narrow sense that repeating it keeps subtracting**
  — it is not idempotent in the "safe to retry" sense: `counters.release` runs
  `UPDATE counters SET count = MAX(0, count - ?) WHERE ...`, floored at zero, so calling `release`
  twice for the same original check will not go negative, but it also does not detect that it has
  already been applied — see the window-boundary limitation below, which is the more serious caveat.

**`release()`'s window-boundary limitation** (verified in `src/domain/rate-limit-service.js`):
`release(input)` computes `now = this.now()` **at release time**, resolves the effective limits, and
for each window calls `this.counters.release(row.name, input.subject, l.window,
SlidingWindow.start(l, now), cost)` — `SlidingWindow.start(l, now)` is the **current** fixed-window
bucket as of the release call, not the bucket that was actually incremented by the original
`check()`/`checkMany()` call. If `release()` is called while still inside the same fixed window as
the original consuming check, this correctly targets and decrements that same bucket. **If enough
time has passed that `now` has rolled into a new fixed window since the original check, `release()`
silently targets the wrong bucket**: either a row that doesn't exist yet (the `UPDATE` matches zero
rows — a harmless no-op) or an existing row from unrelated requests already made in the new window
(which then get erroneously decremented instead of the request that's actually being released). In
neither case does the original over-consumed window's counter ever get corrected — the released
units are effectively lost once a window boundary has passed between check and release. There is no
guard, warning, or documentation of this in the code itself; it is a real, currently-true limitation
of the release path, not a hypothetical.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (default `./data/ratelimit.db`)
plus WAL/SHM sidecars while running. Policy definitions and overrides matter most (they are hand
configured); counters and decision statistics are comparatively disposable (losing them only resets
in-progress windows and historical charts, not correctness going forward). No backup script exists
in this repository; capture today via a stopped-process file copy or SQLite's own online-backup
mechanism (not wired up here).

## Restore
Stop the service, replace `DB_PATH` (and stale `-wal`/`-shm` files) with the backup, start —
`#migrate()` applies any newer migrations automatically. No ordering constraint with other
services' data: policy names and subjects are opaque strings chosen by callers, not foreign keys
into another service's database. Restoring an old backup means any policy/override changes made
after that backup are lost and callers checking against a policy created after the backup would see
`404 POLICY_NOT_FOUND` until it's recreated.

## Metrics
`GET /metrics` (Prometheus text, `read`-role key required):
- `ratelimit_policies` — durable, count of rows in `policies`.
- `ratelimit_decisions_total{policy,decision}` — **process-local**: read from
  `RateLimitService.tally`, an in-memory `Map` incremented by `#count()` on every `checkMany` call;
  resets to 0 on every restart. This is a different number from the *durable* `decisions` table
  (used by `GET /v1/policies/:name/stats` and `GET /v1/stats`, which read `counters.series`/
  `counters.totals` from the database) — **the `/metrics` total and the `/v1/stats` total can
  disagree after any restart**, since one is process-local and the other is durable.
- `ratelimit_counters` — durable, `SELECT COUNT(*) FROM counters` (live window-counter row count).
- `ratelimit_db_bytes` — durable, `Database.sizeBytes()` (`page_count * page_size`).
- `ratelimit_process_uptime_seconds` — process-local, resets on restart.

## Logging
Same as `flags`/`shortlink`: Fastify default request logger, `requestIdHeader: 'x-request-id'`,
`genReqId: randomUUID`, `reqId` on every log line per
[OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md), `req.headers.authorization` redacted. Not
emitted: `traceId`, `spanId`, `route`/`op`, `durationMs` (Fastify's `responseTime` field, different
name), `upstream`/`upstreamMs` (no proxied calls), `service`, `version`. `code` is in every JSON
error body but only additionally logged for 500s via `request.log.error({ err }, 'unhandled error')`.

## Tracing
Accepts whatever `X-Request-Id` the caller sends (no trust gate — internal service reached only via
gateway, console or peers) and generates one when absent. Does **not** parse, forward, or log
`traceparent` — implemented in `gateway` only, as of this review's Stage 1. No outbound calls happen
in the request path (audit is async, off-path, and doesn't forward request-scoped headers), so there
is nothing to propagate onward regardless.

## Security model
Bearer API keys (`RATELIMIT_API_KEYS=id:secret[:role[:policies]]`), compared via SHA-256 +
`timingSafeEqual` (same `ApiKeyAuth` pattern as `flags`/`shortlink`). Roles: `check` (only
`/v1/check`, `/v1/check/batch`, `/v1/release`), `read`, `write`, `readwrite` (default) — `check` is
unique to this service among the four reviewed (`flags`/`shortlink` only have `read`/`write`/
`readwrite`), reflecting that most callers (the gateway, other backends) should only be able to
spend quota, never redefine it. Policy scoping: a key's `policies` list (or `null` for all) is
enforced on every route naming a policy (`ApiKeyAuth.assertPolicy`), including hiding scoped-out
policies from `GET /v1/policies` and `/v1/stats`. No secret rotation support: edit
`RATELIMIT_API_KEYS` and restart. At the boundary: request bodies are schema-validated with a
custom JSON content-type parser that returns a clean `400 INVALID_JSON` instead of Fastify's default
error on malformed JSON (`removeContentTypeParser`/`addContentTypeParser` in `rate-limit-api.js`);
limits are validated against `MAX_LIMITS`/`MAX_WINDOW_SEC`/`MAX_COST` at policy-create/update and
override-set time, not just at check time. Out of scope: authenticating whoever the `subject` string
represents (it's an opaque string the caller vouches for — `ratelimit` does not verify a subject is
a real user/IP/key), enforcement itself (this service only decides `allowed`; a `429` response to
the *original* caller of whatever service is being protected is the caller's job).

## Scaling model
**B — single-node stateful**: one process owns one SQLite file, `instances: 1` pinned in
`ecosystem.config.cjs` ("one process per SQLite file"), and the README's own "Out of scope" section
already states this explicitly ("Distributed counters across several instances of this service: one
process owns one database").

**The check/consume path specifically is safe under two processes sharing one file**, which is a
materially different answer from `shortlink`'s redirect path. `checkMany()` wraps the *entire*
read-decide-write sequence — reading policy/override definitions, reading the current and previous
window counters (`counters.pair`), evaluating every window, and (only if every window allows the
cost) writing the new counts (`counters.add`) and the hourly decision tally (`counters.decide`) — in
one call to `this.db.transaction()`, which issues `BEGIN IMMEDIATE` *before* any of those reads
happen. `BEGIN IMMEDIATE` acquires SQLite's RESERVED lock immediately, at the start of the
transaction, not deferred until the first write; only one such transaction can hold that lock at a
time, across the whole database file, including across separate OS processes connected to the same
file. This means a second process's `checkMany()` cannot begin *its* `BEGIN IMMEDIATE` transaction
— and therefore cannot read the counters — until the first process's transaction has fully committed
or rolled back. There is no window, within or across processes, where two `checkMany()` calls for
the same (or different) subjects can interleave their read and write halves — unlike `shortlink`'s
`follow()`, where the `maxClicks` read happens *outside* the transaction that performs the write.

Where two processes *would* cause a real problem: the **cleanup worker running in two processes**
is not itself unsafe in the sense of corrupting data (`RateLimitService.cleanup()` is also wrapped
in `db.transaction()`, and every statement inside it — `DELETE FROM counters WHERE …`, `DELETE FROM
overrides WHERE …`, `DELETE FROM decisions WHERE …` — is naturally idempotent: deleting rows that
another process already deleted just matches zero rows). The real problem with two instances is
entirely the **process-local state**, not the database: `RateLimitService.tally` (the source of
`ratelimit_decisions_total` in `/metrics`) and the readiness cache would each be independent per
process, so `/metrics` and `/ready` would report different, incomplete pictures depending on which
instance answered a given request — exactly the same class of issue `flags` has with its own
per-process evaluation cache and counters, not a data-correctness issue.

## Single-node / multi-node guarantees
Running two `ratelimit` instances against the same `DB_PATH` is not a topology this repository ships
or tests (`instances: 1` is pinned, and the README says so), but unlike `shortlink`, the specific
concern that motivated this question — whether the check/consume path itself could let two processes
jointly over-spend a policy's quota — **does not apply here**: `BEGIN IMMEDIATE` around the full
read-then-write sequence serializes it globally, so quota enforcement itself would remain correct
under two processes. What would *not* be correct is anything reading `RateLimitService.tally`
(`/metrics`'s `ratelimit_decisions_total`) or each process's own 10s readiness cache, since those are
per-process and not coordinated. `release()`'s window-boundary limitation (above) exists regardless
of instance count — it is a single-process bug in effect, not a concurrency one.

## Known failure modes
- **Disk full**: a write inside `db.transaction()` (check, release, policy/override write, cleanup)
  throws, rolls back, and the request fails `500`; no partial charge is possible because the whole
  check-and-consume sequence is one transaction.
- **Audit service times out or is unreachable mid-request**: no effect on the ratelimit request —
  `record()` is a synchronous in-memory push; network I/O is deferred to the background timer. Long
  enough downtime drops events once `MAX_BUFFER = 5_000` is hit.
- **Process killed without graceful shutdown**: buffered-but-unflushed audit events are lost; the
  SQLite file itself should stay consistent (WAL, atomic commits per `BEGIN IMMEDIATE`/`COMMIT`),
  but the in-flight check being served at the moment of the kill gets no response — a caller cannot
  tell whether that check's cost was actually consumed, and retrying it risks double-charging.
- **Two instances run against one file**: the check/consume path itself stays correct (see Scaling
  model above — this is the one respect in which `ratelimit` is *more* robust to this scenario than
  `shortlink`), but `/metrics`' `ratelimit_decisions_total` and each instance's own readiness cache
  would diverge between the two processes, giving an operator an incomplete picture depending on
  which instance answers a given `/metrics` or `/ready` poll.
- **`release()` called after a window boundary has passed since the original check**: as detailed
  above, the released units are not credited back to the window that was actually over-consumed —
  they are either a no-op or, worse, an erroneous decrement against a different, unrelated window's
  legitimate usage. This is a real, currently-true limitation, not a hypothetical edge case.
