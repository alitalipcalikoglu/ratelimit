import { RateLimitError } from './errors.js';
import { Limits } from './limits.js';
import { SlidingWindow } from './sliding-window.js';

/** @typedef {import('../types.js').CheckInput} CheckInput */
/** @typedef {import('../types.js').Decision} Decision */
/** @typedef {import('../types.js').Limit} Limit */
/** @typedef {import('../types.js').LimitState} LimitState */
/** @typedef {import('../types.js').PolicyRow} PolicyRow */
/** @typedef {import('../types.js').OverrideRow} OverrideRow */

/**
 * Policies, overrides and the check itself. Every check runs in one write transaction: the
 * states of all windows are read, and counters are incremented only when every window allows
 * the cost, so a denied request never consumes anything.
 */
export class RateLimitService {
  /**
   * @param {object} deps
   * @param {import('../db.js').Database} deps.db
   * @param {import('../store/policy-store.js').PolicyStore} deps.policies
   * @param {import('../store/override-store.js').OverrideStore} deps.overrides
   * @param {import('../store/counter-store.js').CounterStore} deps.counters
   * @param {{ maxLimits: number, maxWindowSec: number, maxCost: number, maxBatch: number, statsRetentionDays: number }} deps.options
   * @param {() => number} [deps.now]
   */
  constructor({ db, policies, overrides, counters, options, now = Date.now }) {
    this.db = db;
    this.policies = policies;
    this.overrides = overrides;
    this.counters = counters;
    this.options = options;
    this.now = now;
    /** Decisions since process start, per policy. @type {Map<string, { allowed: number, denied: number }>} */
    this.tally = new Map();
  }

  // ---- policies

  /**
   * @param {{ name: string, description?: string, limits: unknown }} input
   * @param {string} by
   */
  createPolicy(input, by) {
    if (this.policies.get(input.name)) throw new RateLimitError('POLICY_EXISTS', `policy "${input.name}" already exists`);
    const t = this.now();
    return this.policies.insert({ name: input.name, description: input.description ?? '', limits: JSON.stringify(Limits.normalize(input.limits, this.options)), created_by: by, created_at: t, updated_at: t });
  }

  /** @param {string} name */
  getPolicy(name) {
    return this.policies.require(name);
  }

  /**
   * @param {string} name
   * @param {{ description?: string, limits?: unknown }} patch
   */
  updatePolicy(name, patch) {
    const row = this.policies.require(name);
    return this.policies.update({
      ...row,
      description: patch.description ?? row.description,
      limits: patch.limits === undefined ? row.limits : JSON.stringify(Limits.normalize(patch.limits, this.options)),
      updated_at: this.now(),
    });
  }

  /** Delete a policy with its overrides, counters and statistics. @param {string} name */
  removePolicy(name) {
    this.policies.require(name);
    this.db.transaction(() => this.policies.delete(name));
    this.tally.delete(name);
  }

  // ---- overrides

  /**
   * @param {string} policy
   * @param {string} subject
   * @param {{ limits: unknown, note?: string, expiresAt?: string|null }} input
   * @param {string} by
   */
  setOverride(policy, subject, input, by) {
    this.policies.require(policy);
    const t = this.now();
    let expires = null;
    if (input.expiresAt) {
      expires = Date.parse(input.expiresAt);
      if (Number.isNaN(expires)) throw new RateLimitError('INVALID_LIMITS', 'expiresAt must be an ISO 8601 date');
      if (expires <= t) throw new RateLimitError('INVALID_LIMITS', 'expiresAt must be in the future');
    }
    return this.overrides.upsert({ policy, subject, limits: JSON.stringify(Limits.normalize(input.limits, this.options)), note: input.note ?? '', expires_at: expires, created_by: by, created_at: t, updated_at: t });
  }

  /** @param {string} policy @param {string} subject */
  removeOverride(policy, subject) {
    this.policies.require(policy);
    if (!this.overrides.delete(policy, subject)) throw new RateLimitError('OVERRIDE_NOT_FOUND', `no override for "${subject}" in policy "${policy}"`);
  }

  // ---- checks

  /**
   * Check and, unless `peek`, consume `cost` units for one subject.
   * @param {CheckInput} input
   * @param {{ peek?: boolean }} [opts]
   * @returns {Decision}
   */
  check(input, opts = {}) {
    return this.checkMany([input], opts).results[0];
  }

  /**
   * Several checks as one unit: counters move only when every check allows its cost.
   * @param {CheckInput[]} inputs
   * @param {{ peek?: boolean }} [opts]
   * @returns {{ allowed: boolean, results: Decision[] }}
   */
  checkMany(inputs, { peek = false } = {}) {
    if (inputs.length > this.options.maxBatch) throw new RateLimitError('DUPLICATE_CHECK', `at most ${this.options.maxBatch} checks per request`);
    const seen = new Set();
    for (const c of inputs) {
      const key = `${c.policy}\n${c.subject}`;
      if (seen.has(key)) throw new RateLimitError('DUPLICATE_CHECK', `subject "${c.subject}" appears twice for policy "${c.policy}"`);
      seen.add(key);
      const cost = c.cost ?? 1;
      if (!Number.isInteger(cost) || cost < 0 || cost > this.options.maxCost) throw new RateLimitError('COST_TOO_HIGH', `cost must be an integer between 0 and ${this.options.maxCost}`);
    }
    const now = this.now();
    return this.db.transaction(() => {
      const evaluated = inputs.map((c) => {
        const row = this.policies.require(c.policy);
        const cost = c.cost ?? 1;
        const { limits, source } = this.#effective(row, c.subject, now);
        return { cost, limits, decision: this.#evaluate(row.name, c.subject, cost, limits, source, now) };
      });
      const allowed = evaluated.every((e) => e.decision.allowed);
      if (!peek) {
        for (const e of evaluated) {
          if (allowed) for (const l of e.limits) this.counters.add(e.decision.policy, e.decision.subject, l.window, SlidingWindow.start(l, now), e.cost);
          this.counters.decide(e.decision.policy, now, allowed);
          this.#count(e.decision.policy, allowed);
        }
      }
      return { allowed, results: evaluated.map((e) => (allowed || peek ? e.decision : { ...e.decision, allowed: false })) };
    });
  }

  /**
   * Give back units consumed in the current windows (an operation that failed after the check).
   * @param {CheckInput} input
   * @returns {Decision} State after the release.
   */
  release(input) {
    const cost = input.cost ?? 1;
    if (!Number.isInteger(cost) || cost < 1 || cost > this.options.maxCost) throw new RateLimitError('COST_TOO_HIGH', `cost must be an integer between 1 and ${this.options.maxCost}`);
    const now = this.now();
    return this.db.transaction(() => {
      const row = this.policies.require(input.policy);
      const { limits, source } = this.#effective(row, input.subject, now);
      for (const l of limits) this.counters.release(row.name, input.subject, l.window, SlidingWindow.start(l, now), cost);
      return this.#evaluate(row.name, input.subject, 0, limits, source, now);
    });
  }

  /**
   * Current state of a subject without consuming: `remaining` is what is left right now.
   * @param {string} policy
   * @param {string} subject
   */
  usage(policy, subject) {
    const row = this.policies.require(policy);
    const now = this.now();
    const { limits, source } = this.#effective(row, subject, now);
    return { decision: this.#evaluate(row.name, subject, 0, limits, source, now), override: this.overrides.get(policy, subject) ?? null };
  }

  /** Forget every counter of a subject. @param {string} policy @param {string} subject */
  resetUsage(policy, subject) {
    this.policies.require(policy);
    return this.counters.reset(policy, subject);
  }

  /**
   * Subjects with the highest usage in one window of the policy.
   * @param {string} policy
   * @param {number|undefined} window   Defaults to the policy's first (shortest) window.
   * @param {number} limit
   */
  top(policy, window, limit) {
    const row = this.policies.require(policy);
    const limits = Limits.parse(row.limits);
    const l = window === undefined ? limits[0] : limits.find((x) => x.window === window);
    if (!l) throw new RateLimitError('UNKNOWN_WINDOW', `policy "${policy}" has no ${window} s window`);
    const now = this.now();
    return { window: l.window, limit: l.limit, items: this.counters.top(policy, l.window, SlidingWindow.start(l, now), SlidingWindow.weight(l, now), limit) };
  }

  /**
   * Hourly allowed/denied series for the last `hours` hours, gaps filled with zeros.
   * @param {string} policy
   * @param {number} hours
   */
  stats(policy, hours) {
    this.policies.require(policy);
    const H = 3_600_000;
    const end = Math.floor(this.now() / H) * H;
    const since = end - (hours - 1) * H;
    const byHour = new Map(this.counters.series(policy, since).map((r) => [r.hourStart, r]));
    const series = [];
    let allowed = 0;
    let denied = 0;
    for (let t = since; t <= end; t += H) {
      const r = byHour.get(t) ?? { hourStart: t, allowed: 0, denied: 0 };
      allowed += r.allowed;
      denied += r.denied;
      series.push({ hourStart: t, allowed: r.allowed, denied: r.denied });
    }
    return { hours, allowed, denied, series };
  }

  /** Totals per policy over the last 24 hours. */
  totals24h() {
    return this.counters.totals(Math.floor(this.now() / 3_600_000) * 3_600_000 - 23 * 3_600_000);
  }

  /** Remove stale counters, expired overrides and old statistics. @param {number} [now] */
  cleanup(now = this.now()) {
    return this.db.transaction(() => ({
      counters: this.counters.cleanup(now),
      overrides: this.overrides.deleteExpired(now),
      decisions: this.counters.cleanupDecisions(now - this.options.statsRetentionDays * 86_400_000),
    }));
  }

  // ---- internals

  /**
   * @param {PolicyRow} row
   * @param {string} subject
   * @param {number} now
   * @returns {{ limits: Limit[], source: 'policy'|'override' }}
   */
  #effective(row, subject, now) {
    const ov = this.overrides.active(row.name, subject, now);
    return ov ? { limits: Limits.parse(ov.limits), source: 'override' } : { limits: Limits.parse(row.limits), source: 'policy' };
  }

  /**
   * @param {string} policy
   * @param {string} subject
   * @param {number} cost
   * @param {Limit[]} limits
   * @param {'policy'|'override'} source
   * @param {number} now
   * @returns {Decision}
   */
  #evaluate(policy, subject, cost, limits, source, now) {
    /** @type {LimitState[]} */
    const states = [];
    for (const l of limits) {
      if (l.limit > 0 && cost > l.limit) throw new RateLimitError('COST_TOO_HIGH', `cost ${cost} can never fit the ${Limits.label(l)} window of policy "${policy}"`);
      const { prev, cur } = this.counters.pair(policy, subject, l.window, SlidingWindow.start(l, now));
      states.push(SlidingWindow.state(l, prev, cur, now, cost));
    }
    const allowed = states.every((s) => s.allowed);
    // Most restrictive window: least remaining when allowed; when denied, the blocked one or the longest wait.
    const key = allowed
      ? states.reduce((a, s) => (s.remaining < a.remaining ? s : a))
      : states.filter((s) => !s.allowed).reduce((a, s) => (a.retryAfter === null ? a : s.retryAfter === null || s.retryAfter > a.retryAfter ? s : a));
    return { policy, subject, allowed, cost, source, blocked: limits.some((l) => l.limit === 0), limit: key.limit, remaining: key.remaining, resetAt: key.resetAt, retryAfter: allowed ? 0 : key.retryAfter, limits: states };
  }

  /** @param {string} policy @param {boolean} allowed */
  #count(policy, allowed) {
    const t = this.tally.get(policy) ?? { allowed: 0, denied: 0 };
    if (allowed) t.allowed++; else t.denied++;
    this.tally.set(policy, t);
  }
}
