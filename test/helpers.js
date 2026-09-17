import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { RateLimitService } from '../src/domain/rate-limit-service.js';
import { RateLimitApi } from '../src/http/rate-limit-api.js';
import { CounterStore } from '../src/store/counter-store.js';
import { OverrideStore } from '../src/store/override-store.js';
import { PolicyStore } from '../src/store/policy-store.js';
import { SqliteCounterBackend } from '../src/store/sqlite-counter-backend.js';

export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WRITE_KEY = 'w'.repeat(40);
export const CHECK_KEY = 'c'.repeat(40);
export const SHOP_KEY = 'p'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return {
    PORT: '0',
    RATELIMIT_API_KEYS: `console:${RW_KEY},viewer:${READ_KEY}:read,admin:${WRITE_KEY}:write,gateway:${CHECK_KEY}:check,shop:${SHOP_KEY}:readwrite:api+login`,
    DB_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    MAX_BATCH: '3',
    ...overrides,
  };
}

/** @param {Record<string, string>} [overrides] */
export function testConfig(overrides) {
  return Config.fromEnv(testEnv(overrides));
}

/** Wired domain objects over an in-memory database with a controllable clock. @param {Record<string, string>} [overrides] */
export function testService(overrides) {
  const config = testConfig(overrides);
  const clock = { t: Date.parse('2026-09-17T10:00:00Z') };
  const db = new Database(':memory:');
  const policies = new PolicyStore(db);
  const overridesStore = new OverrideStore(db);
  const counters = new CounterStore(db);
  const backend = new SqliteCounterBackend(db, counters);
  const service = new RateLimitService({ backend, policies, overrides: overridesStore, options: config, now: () => clock.t });
  return { config, db, policies, overrides: overridesStore, counters, backend, service, clock };
}

/** Fully wired Fastify app. @param {Record<string, string>} [overrides] @param {object} [deps] Extra constructor deps, e.g. an AuditClient. */
export async function buildApp(overrides, deps = {}) {
  const t = testService(overrides);
  const app = await new RateLimitApi({ version: '0.0.0-test', ...t, ...deps, logger: /** @type {any} */ ({ info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return this; } }) }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
