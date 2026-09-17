import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimitError } from '../src/domain/errors.js';
import { testService } from './helpers.js';

const T = Date.parse('2026-09-17T10:00:00Z');
const API = [{ window: 60, limit: 3 }, { window: 3600, limit: 5 }];

test('Service: check consumes across windows, denies with the most restrictive window, peek and release', () => {
  const { service, clock, counters } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  const c = () => service.check({ policy: 'api', subject: 'u1' });
  assert.deepEqual([c().remaining, c().remaining, c().remaining], [2, 1, 0]);
  let d = c();
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.retryAfter, d.source, d.blocked], [false, 3, 0, 60, 'policy', false]);
  clock.t = T + 60_000;
  d = c();
  assert.deepEqual([d.allowed, d.retryAfter], [false, 20], 'previous window still weighs fully');
  clock.t = T + 80_000;
  assert.equal(c().allowed, true, 'allowed exactly when the hint says');
  clock.t = T + 120_000;
  assert.equal(c().allowed, true);
  d = c();
  assert.deepEqual([d.allowed, d.limit, d.remaining, d.retryAfter, d.limits.map((l) => l.allowed)], [false, 5, 0, 3480, [true, false]], 'hourly window denies');
  assert.equal(service.check({ policy: 'api', subject: 'u2' }, { peek: true }).remaining, 2);
  assert.equal(service.check({ policy: 'api', subject: 'u2' }, { peek: true }).remaining, 2, 'peek does not consume');
  assert.equal(service.tally.get('api')?.allowed, 5);
  assert.equal(service.tally.get('api')?.denied, 3);
  assert.equal(counters.pair('api', 'u2', 60, T + 120_000).cur, 0);

  d = service.release({ policy: 'api', subject: 'u1', cost: 1 });
  assert.deepEqual([d.limits[1].used, d.limits[1].remaining, d.allowed], [4, 1, true]);
  assert.equal(c().allowed, true, 'released unit is available again');
  assert.throws(() => service.check({ policy: 'api', subject: 'u1', cost: 4 }), (e) => e instanceof RateLimitError && e.code === 'COST_TOO_HIGH');
  assert.throws(() => service.check({ policy: 'none', subject: 'u1' }), (e) => e instanceof RateLimitError && e.code === 'POLICY_NOT_FOUND');
});

test('Service: overrides replace limits, block, and expire', () => {
  const { service, clock, overrides } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  service.setOverride('api', 'vip', { limits: [{ window: 60, limit: 100 }], note: 'partner' }, 'admin');
  for (let i = 0; i < 4; i++) assert.equal(service.check({ policy: 'api', subject: 'vip' }).allowed, true);
  let d = service.check({ policy: 'api', subject: 'vip' });
  assert.deepEqual([d.source, d.limit, d.remaining], ['override', 100, 95]);
  service.setOverride('api', 'bad', { limits: [{ window: 60, limit: 0 }] }, 'admin');
  d = service.check({ policy: 'api', subject: 'bad' });
  assert.deepEqual([d.allowed, d.blocked, d.retryAfter, d.remaining], [false, true, null, 0]);
  service.setOverride('api', 'tmp', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(T + 1000).toISOString() }, 'admin');
  assert.equal(service.check({ policy: 'api', subject: 'tmp' }).source, 'override');
  clock.t = T + 1000;
  assert.equal(service.check({ policy: 'api', subject: 'tmp' }).source, 'policy', 'expired override is ignored');
  assert.equal(service.usage('api', 'tmp').override?.expires_at, T + 1000, 'but still listed until cleanup');
  assert.throws(() => service.setOverride('api', 'x', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(T).toISOString() }, 'admin'), /in the future/);
  assert.throws(() => service.setOverride('api', 'x', { limits: [{ window: 60, limit: 1 }], expiresAt: 'soon' }, 'admin'), /ISO 8601/);
  service.removeOverride('api', 'vip');
  assert.throws(() => service.removeOverride('api', 'vip'), (e) => e instanceof RateLimitError && e.code === 'OVERRIDE_NOT_FOUND');
  assert.equal(overrides.count('api'), 2);
  assert.equal(service.check({ policy: 'api', subject: 'vip' }).source, 'policy');
});

test('Service: batch checks are all-or-nothing', () => {
  const { service } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  service.createPolicy({ name: 'login', limits: [{ window: 60, limit: 1 }] }, 'admin');
  const checks = [{ policy: 'api', subject: 'u1' }, { policy: 'login', subject: 'u1' }];
  assert.equal(service.checkMany(checks).allowed, true);
  const r = service.checkMany(checks);
  assert.deepEqual([r.allowed, r.results.map((d) => d.allowed)], [false, [false, false]]);
  assert.equal(service.usage('api', 'u1').decision.limits[0].used, 1, 'denied batch consumed nothing');
  assert.equal(service.tally.get('api')?.denied, 1, 'but counts as a denied decision');
  assert.throws(() => service.checkMany([...checks, { policy: 'api', subject: 'u1' }]), (e) => e instanceof RateLimitError && e.code === 'DUPLICATE_CHECK');
  assert.throws(() => service.checkMany([{ policy: 'api', subject: 'a' }, { policy: 'api', subject: 'b' }, { policy: 'api', subject: 'c' }, { policy: 'api', subject: 'd' }]), /at most 3/);
});

test('Service: usage, reset, top, stats, cleanup and policy removal', () => {
  const { service, clock, counters, overrides } = testService();
  service.createPolicy({ name: 'api', limits: API }, 'admin');
  for (const [s, n] of [['a', 3], ['b', 2], ['c', 1]]) for (let i = 0; i < Number(n); i++) service.check({ policy: 'api', subject: String(s) });
  service.check({ policy: 'api', subject: 'a' });
  assert.deepEqual(service.top('api', undefined, 10), { window: 60, limit: 3, items: [{ subject: 'a', used: 3 }, { subject: 'b', used: 2 }, { subject: 'c', used: 1 }] });
  assert.throws(() => service.top('api', 7, 10), (e) => e instanceof RateLimitError && e.code === 'UNKNOWN_WINDOW');
  assert.equal(service.resetUsage('api', 'a'), 2);
  assert.equal(service.usage('api', 'a').decision.remaining, 3);
  clock.t = T + 3_600_000;
  service.check({ policy: 'api', subject: 'a' });
  const st = service.stats('api', 3);
  assert.deepEqual([st.series.length, st.allowed, st.denied, st.series.map((x) => x.allowed)], [3, 7, 1, [0, 6, 1]]);
  assert.deepEqual(service.totals24h().get('api'), { allowed: 7, denied: 1 });
  service.setOverride('api', 'tmp', { limits: [{ window: 60, limit: 1 }], expiresAt: new Date(clock.t + 1000).toISOString() }, 'admin');
  clock.t += 2 * 86_400_000;
  assert.deepEqual(service.cleanup(), { counters: 6, overrides: 1, decisions: 0 });
  clock.t += 29 * 86_400_000;
  assert.equal(service.cleanup().decisions, 2);
  service.updatePolicy('api', { limits: [{ window: 10, limit: 1 }] });
  assert.equal(service.getPolicy('api').limits, '[{"window":10,"limit":1}]');
  service.check({ policy: 'api', subject: 'z' });
  service.setOverride('api', 'z', { limits: [{ window: 10, limit: 9 }] }, 'admin');
  service.removePolicy('api');
  assert.deepEqual([counters.total(), overrides.count('api'), service.tally.has('api')], [0, 0, false]);
  assert.throws(() => service.createPolicy({ name: 'x', limits: [] }, 'admin'), (e) => e instanceof RateLimitError && e.code === 'INVALID_LIMITS');
  service.createPolicy({ name: 'x', limits: [{ window: 1, limit: 1 }] }, 'admin');
  assert.throws(() => service.createPolicy({ name: 'x', limits: [{ window: 1, limit: 1 }] }, 'admin'), (e) => e instanceof RateLimitError && e.code === 'POLICY_EXISTS');
});
