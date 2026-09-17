import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitError } from '../src/domain/errors.js';
import { Limits } from '../src/domain/limits.js';
import { SlidingWindow } from '../src/domain/sliding-window.js';

const T = Date.parse('2026-09-17T10:00:00Z');
const L = { window: 60, limit: 10 };

test('SlidingWindow: weighted estimate, remaining and reset', () => {
  assert.deepEqual(SlidingWindow.state(L, 4, 3, T, 1), { window: 60, limit: 10, used: 7, remaining: 2, allowed: true, resetAt: T + 60_000, retryAfter: 0 });
  assert.deepEqual([SlidingWindow.state(L, 4, 3, T + 30_000, 1).used, SlidingWindow.state(L, 4, 3, T + 30_000, 1).remaining], [5, 4]);
  assert.equal(SlidingWindow.state({ window: 60, limit: 3 }, 3, 0, T + 20_000, 1).allowed, true, 'exact thirds do not deny by floating error');
});

test('SlidingWindow: retry hints', () => {
  const decay = SlidingWindow.state(L, 10, 0, T + 30_000, 6);
  assert.deepEqual([decay.allowed, decay.retryAfter], [false, 6], 'wait for the previous window to decay');
  assert.equal(SlidingWindow.state(L, 10, 0, T + 36_000, 6).allowed, true, 'fits after the hinted wait');
  assert.equal(SlidingWindow.state(L, 0, 10, T + 30_000, 1).retryAfter, 30, 'full current window: wait for its end');
  const blocked = SlidingWindow.state({ window: 60, limit: 0 }, 0, 0, T, 1);
  assert.deepEqual([blocked.allowed, blocked.remaining, blocked.retryAfter], [false, 0, null]);
  assert.equal(SlidingWindow.state(L, 0, 10, T, 0).allowed, true, 'cost 0 only observes');
});

test('Limits: normalises and rejects', () => {
  const bounds = { maxLimits: 3, maxWindowSec: 86_400 };
  assert.deepEqual(Limits.normalize([{ window: 3600, limit: 100 }, { window: 60, limit: 5 }], bounds), [{ window: 60, limit: 5 }, { window: 3600, limit: 100 }]);
  const bad = (/** @type {unknown} */ v, /** @type {RegExp} */ re) => assert.throws(() => Limits.normalize(v, bounds), (e) => e instanceof RateLimitError && e.code === 'INVALID_LIMITS' && re.test(e.message));
  bad([], /non-empty/);
  bad([{ window: 60, limit: 1 }, { window: 60, limit: 2 }], /appears twice/);
  bad([{ window: 1, limit: 1 }, { window: 2, limit: 1 }, { window: 3, limit: 1 }, { window: 4, limit: 1 }], /at most 3/);
  bad([{ window: 0, limit: 1 }], /between 1 and 86400/);
  bad([{ window: 60, limit: -1 }], /between 0 and/);
  bad([{ window: 60, limit: 1.5 }], /between 0 and/);
  assert.equal(Limits.label({ window: 60, limit: 100 }), '100/60s');
});
