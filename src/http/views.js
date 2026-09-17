import { Limits } from '../domain/limits.js';

/** @typedef {import('../types.js').PolicyRow} PolicyRow */
/** @typedef {import('../types.js').OverrideRow} OverrideRow */
/** @typedef {import('../types.js').Decision} Decision */

/** Response shapes. */
export class Views {
  /** @param {number|null} t */
  static iso(t) {
    return t === null ? null : new Date(Number(t)).toISOString();
  }

  /**
   * @param {PolicyRow} p
   * @param {{ overrides?: number, allowed?: number, denied?: number, subjects?: number }} [extra]
   */
  static policy(p, extra = {}) {
    return {
      name: p.name, description: p.description, limits: Limits.parse(p.limits),
      overrides: extra.overrides ?? 0, activeSubjects: extra.subjects ?? 0, last24h: { allowed: extra.allowed ?? 0, denied: extra.denied ?? 0 },
      createdBy: p.created_by, createdAt: Views.iso(p.created_at), updatedAt: Views.iso(p.updated_at),
    };
  }

  /** @param {OverrideRow} o @param {number} now */
  static override(o, now) {
    const limits = Limits.parse(o.limits);
    return { policy: o.policy, subject: o.subject, limits, blocked: limits.some((l) => l.limit === 0), note: o.note, expiresAt: Views.iso(o.expires_at), expired: o.expires_at !== null && o.expires_at <= now, createdBy: o.created_by, createdAt: Views.iso(o.created_at), updatedAt: Views.iso(o.updated_at) };
  }

  /** @param {Decision} d */
  static decision(d) {
    return { ...d, resetAt: Views.iso(d.resetAt), consumedAt: Views.iso(d.consumedAt), limits: d.limits.map((l) => ({ ...l, resetAt: Views.iso(l.resetAt) })) };
  }
}
