/** @typedef {import('../types.js').Limit} Limit */
/** @typedef {import('../types.js').LimitState} LimitState */

/**
 * Sliding-window counter: the current fixed window plus the previous one weighted by how much of
 * it still overlaps the trailing window. Two counters per subject and window, no per-request log,
 * no boundary burst of two full windows.
 */
export class SlidingWindow {
  /** Window length in ms. @param {Limit} l */
  static span(l) {
    return l.window * 1000;
  }

  /** Start of the fixed window containing `now`. @param {Limit} l @param {number} now */
  static start(l, now) {
    const w = SlidingWindow.span(l);
    return Math.floor(now / w) * w;
  }

  /** Weight of the previous window at `now`, in (0, 1]. @param {Limit} l @param {number} now */
  static weight(l, now) {
    const w = SlidingWindow.span(l);
    return (w - (now - SlidingWindow.start(l, now))) / w;
  }

  /**
   * @param {Limit} l
   * @param {number} prev   Count in the previous fixed window.
   * @param {number} cur    Count in the current fixed window.
   * @param {number} now
   * @param {number} cost
   * @returns {LimitState} `remaining` is what is left after this cost when allowed.
   */
  static state(l, prev, cur, now, cost) {
    const w = SlidingWindow.span(l);
    const start = SlidingWindow.start(l, now);
    // Integer numerator before the single division: prev * 40000 / 60000 is exactly 2 for prev 3,
    // where prev * (40000 / 60000) would land a hair above 2 and deny a request that fits.
    const used = (prev * (w - (now - start))) / w + cur;
    const allowed = used + cost <= l.limit;
    const resetAt = start + w;
    /** @type {number|null} */
    let retryAfter = 0;
    if (!allowed) {
      if (l.limit === 0) retryAfter = null;
      else if (prev > 0 && cur + cost <= l.limit) {
        // Wait until the previous window has decayed enough: prev * weight' + cur + cost = limit.
        const weightNeeded = (l.limit - cur - cost) / prev;
        retryAfter = Math.max(1, Math.ceil((start + w * (1 - weightNeeded) - now) / 1000));
      } else retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
    }
    return { window: l.window, limit: l.limit, used: Math.round(used * 100) / 100, remaining: Math.max(0, Math.floor(l.limit - used - (allowed ? cost : 0))), allowed, resetAt, retryAfter };
  }
}
