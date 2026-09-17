import { parentPort, workerData } from 'node:worker_threads';
import { Database } from '../../src/db.js';
import { CounterStore } from '../../src/store/counter-store.js';
import { SqliteCounterBackend } from '../../src/store/sqlite-counter-backend.js';

/**
 * Runs inside its own OS thread with its own SQLite connection (its own `DatabaseSync`, its own
 * file descriptor) against the SAME database file the main thread and every sibling worker point
 * at — real cross-connection concurrency, not `Promise.all` on one connection. Spawned by
 * `test/concurrency.test.js`.
 * @type {{ path: string, policy: string, subject: string, limits: { window: number, limit: number }[], now: number, attempts: number }}
 */
const { path, policy, subject, limits, now, attempts } = workerData;

const db = new Database(path);
const backend = new SqliteCounterBackend(db, new CounterStore(db));
let allowed = 0;
for (let i = 0; i < attempts; i++) {
  const r = backend.checkAndConsume([{ policy, subject, cost: 1, limits }], now);
  if (r.allowed) allowed++;
}
db.close();
parentPort?.postMessage({ allowed });
