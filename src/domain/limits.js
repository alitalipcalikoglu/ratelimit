import { RateLimitError } from './errors.js';

/** @typedef {import('../types.js').Limit} Limit */

/** Validation and formatting of limit lists. */
export class Limits {
  /**
   * Normalise a limit list: integers, distinct windows, sorted by window ascending.
   * @param {unknown} input
   * @param {{ maxLimits: number, maxWindowSec: number }} bounds
   * @returns {Limit[]}
   */
  static normalize(input, bounds) {
    if (!Array.isArray(input) || input.length === 0) throw new RateLimitError('INVALID_LIMITS', 'limits must be a non-empty array');
    if (input.length > bounds.maxLimits) throw new RateLimitError('INVALID_LIMITS', `at most ${bounds.maxLimits} limits per policy`);
    /** @type {Limit[]} */
    const out = [];
    for (const raw of input) {
      const l = /** @type {{ window?: unknown, limit?: unknown }} */ (raw);
      if (!Number.isInteger(l.window) || /** @type {number} */ (l.window) < 1 || /** @type {number} */ (l.window) > bounds.maxWindowSec) throw new RateLimitError('INVALID_LIMITS', `window must be an integer between 1 and ${bounds.maxWindowSec} seconds`);
      if (!Number.isInteger(l.limit) || /** @type {number} */ (l.limit) < 0 || /** @type {number} */ (l.limit) > 1_000_000_000) throw new RateLimitError('INVALID_LIMITS', 'limit must be an integer between 0 and 1000000000');
      if (out.some((o) => o.window === l.window)) throw new RateLimitError('INVALID_LIMITS', `window ${l.window} appears twice`);
      out.push({ window: /** @type {number} */ (l.window), limit: /** @type {number} */ (l.limit) });
    }
    return out.sort((a, b) => a.window - b.window);
  }

  /** @param {string} json */
  static parse(json) {
    return /** @type {Limit[]} */ (JSON.parse(json));
  }

  /** Human form: `100/60s`. @param {Limit} l */
  static label(l) {
    return `${l.limit}/${l.window}s`;
  }
}
