/** @typedef {import('../types.js').Limit} Limit */
/** @typedef {import('../types.js').LimitState} LimitState */

/**
 * One check already resolved to its effective limits (policy or override, whichever applies) —
 * everything a backend needs to evaluate and, if allowed, consume it. Policy/override lookup and
 * cost bounds stay in {@link import('./rate-limit-service.js').RateLimitService}; a backend never
 * sees a policy name that doesn't resolve, or a cost outside the configured bounds.
 * @typedef {object} ResolvedCheck
 * @property {string} policy
 * @property {string} subject
 * @property {number} cost
 * @property {Limit[]} limits
 */

/**
 * Storage for rate-limit window counters and hourly decision totals, decoupled from any one
 * store. `RateLimitService` depends on this interface only — no `db`, no SQL, no transaction
 * object leaks into the domain layer. `SqliteCounterBackend` is the only implementation today; a
 * future Redis-backed one must satisfy the same atomicity contract documented per method below.
 *
 * What this interface deliberately does NOT own: which limits apply to a check (policy vs.
 * override resolution), or whether a cost is within bounds — both stay in `RateLimitService`,
 * because they are policy semantics, not counter storage. A backend receives only
 * already-resolved {@link ResolvedCheck}s.
 *
 * Window math (`SlidingWindow`) is a third, storage-agnostic layer: pure functions shared by every
 * backend implementation, not duplicated per backend and not owned by the domain service either.
 */
export class CounterBackend {
  /**
   * Evaluate and, unless every check in the batch is allowed or `peek` is set, consume every
   * check's cost against its own limits.
   *
   * ATOMICITY (the core contract): this call is one atomic unit across the WHOLE batch and EVERY
   * limit of every check in it.
   *   - If every check's every limit allows its cost: every limit of every check is consumed
   *     (unless `peek`), and no other caller's concurrent `checkAndConsume` may observe a partial
   *     state of this batch (a limit consumed while a sibling limit of the same check is not).
   *   - If ANY check is denied: NOTHING in the batch is consumed — not even the limits of checks
   *     that individually would have passed. This is the existing `checkMany` invariant
   *     (`rate-limit-service.js`, unchanged) and it must be provided by the backend itself, not by
   *     a single-process mutex — a future multi-instance backend (Redis) has no JS event loop to
   *     lean on, so the all-or-nothing guarantee has to be a property of the backend's own atomic
   *     operation (for SQLite: one `BEGIN IMMEDIATE` transaction; for Redis: one Lua script or
   *     server-side function — see `docs/READINESS.md`'s "Redis-readiness" note).
   *   - Concurrent `checkAndConsume` calls for the SAME (policy, subject, window) must serialize:
   *     two callers racing to consume the last unit of a limit must not both succeed.
   *   - `peek: true` never consumes, regardless of `allowed` — it still needs the same read
   *     consistency (no torn read of prev/cur across a concurrent write) but not the write side of
   *     the contract.
   *
   * @param {ResolvedCheck[]} checks
   * @param {number} now Instant to evaluate against, ms since epoch (caller-supplied so the domain
   *   layer owns the clock — see `rate-limit-service.js`'s "Clock model").
   * @param {{ peek?: boolean }} [opts]
   * @returns {{ allowed: boolean, states: LimitState[][] }} `states[i]` has one entry per
   *   `checks[i].limits`, in the same order.
   */
  checkAndConsume(checks, now, opts) {
    throw new Error('CounterBackend.checkAndConsume: not implemented');
  }

  /**
   * Give back `cost` units that were consumed by an earlier `checkAndConsume` at `consumedAt`, for
   * every limit in `limits`, then return the state of those limits evaluated at `now`.
   *
   * The window each limit's release targets is deterministically derived from `consumedAt`, the
   * same instant that was passed to the original `checkAndConsume` — NOT from `now`. This is the
   * Stage 5 fix: releasing after a window boundary has passed must credit the window that was
   * actually consumed, never the window `now` happens to fall in (which may be a fresh window that
   * was never incremented, or the wrong one). A caller that cannot supply the original
   * `consumedAt` (e.g. an older client) gets the pre-fix behavior by construction, since
   * `RateLimitService.release` defaults `consumedAt` to `now` when omitted — never by the backend
   * silently guessing.
   *
   * A release must never take a counter below zero, under any sequence of releases (duplicate
   * release, release after cleanup already removed the window, release with a cost larger than
   * what remains) — clamp at zero rather than throw or go negative.
   *
   * ATOMICITY: the decrement of every limit and the read used to build the returned state happen
   * as one atomic operation; a concurrent `checkAndConsume` must not observe a state where only
   * some of this release's limits have been applied.
   *
   * @param {string} policy
   * @param {string} subject
   * @param {Limit[]} limits
   * @param {number} consumedAt ms since epoch; the instant the original consume happened at.
   * @param {number} cost
   * @param {number} now ms since epoch; the instant to evaluate the returned state at.
   * @returns {LimitState[]} One entry per `limits`, in the same order, `cost: 0` (a release never
   *   itself consumes).
   */
  release(policy, subject, limits, consumedAt, cost, now) {
    throw new Error('CounterBackend.release: not implemented');
  }

  /** Forget every counter of one subject across every policy window. Returns rows removed. @param {string} policy @param {string} subject @returns {number} */
  reset(policy, subject) {
    throw new Error('CounterBackend.reset: not implemented');
  }

  /**
   * Subjects with the highest sliding-window usage of one window right now.
   * @param {string} policy @param {number} window @param {number} curStart @param {number} weight @param {number} limit
   * @returns {{ subject: string, used: number }[]}
   */
  top(policy, window, curStart, weight, limit) {
    throw new Error('CounterBackend.top: not implemented');
  }

  /** Distinct subjects with a live window. @param {string} policy @param {number} now @returns {number} */
  activeSubjects(policy, now) {
    throw new Error('CounterBackend.activeSubjects: not implemented');
  }

  /** Remove counters older than two windows (they can no longer affect a sliding estimate). @param {number} now @returns {number} */
  cleanup(now) {
    throw new Error('CounterBackend.cleanup: not implemented');
  }

  /**
   * Record one decision (allowed/denied) toward the hourly total. Deliberately NOT required to be
   * atomic with the `checkAndConsume` that produced it: a Redis-backed counter store can never
   * share one atomic operation with a local SQL statistics table, so coupling them would either
   * make a Redis backend impossible to build against this contract, or wrongly pull statistics
   * into the counter backend's own atomicity boundary. The blast radius of the two ever
   * diverging (process crash between the two calls) is a possibly-off-by-one dashboard count,
   * never an actual rate-limit enforcement decision — enforcement is entirely `checkAndConsume`'s
   * contract, not this one's.
   * @param {string} policy @param {number} now @param {boolean} allowed
   */
  decide(policy, now, allowed) {
    throw new Error('CounterBackend.decide: not implemented');
  }

  /** Hourly allowed/denied series from `since` (ms). @param {string} policy @param {number} since @returns {{ hourStart: number, allowed: number, denied: number }[]} */
  series(policy, since) {
    throw new Error('CounterBackend.series: not implemented');
  }

  /** Allowed/denied totals per policy since `since` (ms). @param {number} since @returns {Map<string, { allowed: number, denied: number }>} */
  totals(since) {
    throw new Error('CounterBackend.totals: not implemented');
  }

  /** @param {number} before @returns {number} */
  cleanupDecisions(before) {
    throw new Error('CounterBackend.cleanupDecisions: not implemented');
  }

  /** Live counter rows across every policy — a cheap size signal for `/stats` and `/metrics`, not a correctness primitive. @returns {number} */
  total() {
    throw new Error('CounterBackend.total: not implemented');
  }
}
