import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** SQLite connection with schema migrations applied on open. */
export class Database {
  /** @type {readonly string[]} */
  static MIGRATIONS = [
    `
    CREATE TABLE policies (
      name        TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      limits      TEXT NOT NULL,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    -- Per-subject limits that replace the policy's limits; a limit of 0 blocks the subject.
    CREATE TABLE overrides (
      policy     TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      subject    TEXT NOT NULL,
      limits     TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      expires_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (policy, subject)
    );

    -- Fixed-window counters; the sliding estimate reads the current and the previous window.
    -- Rows older than two windows are removed by the cleanup worker.
    CREATE TABLE counters (
      policy       TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      window       INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL,
      PRIMARY KEY (policy, subject, window, window_start)
    ) WITHOUT ROWID;
    CREATE INDEX counters_top ON counters (policy, window, window_start, count DESC);

    -- Hourly allowed/denied totals per policy for statistics.
    CREATE TABLE decisions (
      policy     TEXT NOT NULL REFERENCES policies(name) ON DELETE CASCADE,
      hour_start INTEGER NOT NULL,
      allowed    INTEGER NOT NULL DEFAULT 0,
      denied     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (policy, hour_start)
    ) WITHOUT ROWID;
    `,
  ];
  /** @param {string} path File path, or ":memory:". */
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    /** @readonly */
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.#migrate();
  }

  #migrate() {
    const { user_version: current } = /** @type {{ user_version: number }} */ (this.raw.prepare('PRAGMA user_version').get());
    for (let v = current; v < Database.MIGRATIONS.length; v++) {
      this.raw.exec('BEGIN');
      try {
        this.raw.exec(Database.MIGRATIONS[v]);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
        this.raw.exec('COMMIT');
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    }
  }

  /** @param {string} sql */
  prepare(sql) {
    return this.raw.prepare(sql);
  }

  /**
   * Run `fn` inside a write transaction; rolls back on throw.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  /** Cheap liveness probe; throws if the connection is unusable. */
  ping() {
    this.raw.prepare('SELECT 1').get();
  }

  /** Database file size in bytes. */
  sizeBytes() {
    const r = /** @type {{ bytes: number }} */ (this.raw.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get());
    return Number(r.bytes);
  }

  close() {
    this.raw.close();
  }
}
