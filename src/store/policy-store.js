import { RateLimitError } from '../domain/errors.js';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').PolicyRow} PolicyRow */

/** Persistence for policy definitions. */
export class PolicyStore {
  static COLUMNS = 'name, description, limits, created_by, created_at, updated_at';

  /** @param {Database} db */
  constructor(db) {
    const C = PolicyStore.COLUMNS;
    this.stmt = {
      insert: db.prepare(`INSERT INTO policies (${C}) VALUES (?, ?, ?, ?, ?, ?)`),
      get: db.prepare(`SELECT ${C} FROM policies WHERE name = ?`),
      all: db.prepare(`SELECT ${C} FROM policies ORDER BY name`),
      update: db.prepare(`UPDATE policies SET description = ?, limits = ?, updated_at = ? WHERE name = ?`),
      delete: db.prepare(`DELETE FROM policies WHERE name = ?`),
    };
  }

  /** @param {PolicyRow} r */
  insert(r) {
    this.stmt.insert.run(r.name, r.description, r.limits, r.created_by, r.created_at, r.updated_at);
    return r;
  }

  /** @param {string} name */
  get(name) {
    return /** @type {PolicyRow|undefined} */ (this.stmt.get.get(name));
  }

  /** @param {string} name */
  require(name) {
    const row = this.get(name);
    if (!row) throw new RateLimitError('POLICY_NOT_FOUND', `policy "${name}" not found`);
    return row;
  }

  all() {
    return /** @type {PolicyRow[]} */ (this.stmt.all.all());
  }

  /** @param {PolicyRow} r */
  update(r) {
    this.stmt.update.run(r.description, r.limits, r.updated_at, r.name);
    return r;
  }

  /** @param {string} name */
  delete(name) {
    return Number(this.stmt.delete.run(name).changes) > 0;
  }
}
