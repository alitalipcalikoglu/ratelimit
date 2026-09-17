import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Database } from '../src/db.js';
import { CounterStore } from '../src/store/counter-store.js';
import { PolicyStore } from '../src/store/policy-store.js';
import { SqliteCounterBackend } from '../src/store/sqlite-counter-backend.js';

const WORKER_PATH = fileURLToPath(new URL('./helpers/concurrency-worker.js', import.meta.url));

/** @param {import('worker_threads').WorkerOptions['workerData']} workerData */
function runWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, { workerData });
    worker.once('message', (msg) => resolve(/** @type {{ allowed: number }} */ (msg)));
    worker.once('error', reject);
  });
}

// This is the one test in the suite that exercises REAL concurrency: several OS threads, each
// with its own SQLite connection to the SAME file, racing to consume the same counter. Everywhere
// else (`test/backend-contract.test.js`, `test/service.test.js`) a "concurrent" scenario is really
// sequential JS calls on one connection — useful for the logical invariant, but it cannot exercise
// `BEGIN IMMEDIATE` write-lock contention or `PRAGMA busy_timeout` across processes/threads, which
// is the actual mechanism `checkAndConsume`'s atomicity contract leans on for SQLite (see
// `src/store/sqlite-counter-backend.js`'s module doc).
test('Concurrency: several real connections racing for one limit never over-consume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratelimit-concurrency-'));
  const path = join(dir, 'counters.db');
  try {
    const T = Date.now();
    const LIMIT = 10;
    const WORKERS = 4;
    const ATTEMPTS_EACH = 15; // 60 total attempts contending for 10 units
    const limits = [{ window: 60, limit: LIMIT }];

    const seed = new Database(path);
    new PolicyStore(seed).insert({ name: 'api', description: '', limits: '[]', created_by: 'test', created_at: 0, updated_at: 0 });
    seed.close();

    const results = await Promise.all(Array.from({ length: WORKERS }, () => runWorker({ path, policy: 'api', subject: 'u1', limits, now: T, attempts: ATTEMPTS_EACH })));
    const totalAllowed = results.reduce((sum, r) => sum + r.allowed, 0);
    assert.equal(totalAllowed, LIMIT, 'exactly LIMIT attempts won across every thread combined, never more');

    const db = new Database(path);
    const backend = new SqliteCounterBackend(db, new CounterStore(db));
    const check = backend.checkAndConsume([{ policy: 'api', subject: 'u1', cost: 0, limits }], T, { peek: true });
    assert.equal(check.states[0][0].used, LIMIT, 'the counter itself reflects exactly LIMIT consumed, no lost or double-counted updates');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
