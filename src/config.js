/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static POLICY_PATTERN = /^[a-z0-9]+([.\-_][a-z0-9]+)*$/;
  static ROLES = ['check', 'read', 'write', 'readwrite'];

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.maxLimits = v.maxLimits;
    this.maxWindowSec = v.maxWindowSec;
    this.maxCost = v.maxCost;
    this.maxBatch = v.maxBatch;
    this.cleanupIntervalSec = v.cleanupIntervalSec;
    this.statsRetentionDays = v.statsRetentionDays;
    Object.freeze(this);
  }

  /**
   * @param {NodeJS.ProcessEnv} [env]
   * @returns {Config}
   */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);

    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');

    return new Config({
      port: r.integer('PORT', 3011, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: Config.#parseAudit(r),
      bodyLimit: r.integer('BODY_LIMIT', 65_536, { min: 1_024 }),
      dbPath: r.optional('DB_PATH') || './data/ratelimit.db',
      apiKeys: Config.#parseApiKeys(r.required('RATELIMIT_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 6_000, { min: 1 }),
      maxLimits: r.integer('MAX_LIMITS', 5, { min: 1, max: 20 }),
      maxWindowSec: r.integer('MAX_WINDOW_SEC', 2_592_000, { min: 1 }),
      maxCost: r.integer('MAX_COST', 1_000_000, { min: 1 }),
      maxBatch: r.integer('MAX_BATCH', 20, { min: 1, max: 100 }),
      cleanupIntervalSec: r.integer('CLEANUP_INTERVAL_SEC', 60, { min: 1 }),
      statsRetentionDays: r.integer('STATS_RETENTION_DAYS', 30, { min: 1 }),
    });
  }

  /**
   * Parse `id:secret[:role[:policy+policy]]`. Role defaults to `readwrite`, policies to all.
   * Policy names are not checked against existing policies: keys may be issued first.
   * @param {string} raw
   * @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    const keys = raw.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
      const parts = entry.split(':');
      if (parts.length < 2 || parts.length > 4) throw new ConfigError(`RATELIMIT_API_KEYS entry "${entry.slice(0, 8)}…" must be id:secret[:role[:policies]]`);
      const [id, secret, role = 'readwrite', policyList = ''] = parts;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConfigError(`RATELIMIT_API_KEYS id "${id}" must match [A-Za-z0-9_-]{1,64}`);
      if (secret.length < Config.MIN_SECRET_LENGTH) throw new ConfigError(`RATELIMIT_API_KEYS secret for "${id}" must be at least ${Config.MIN_SECRET_LENGTH} characters`);
      if (!Config.ROLES.includes(role)) throw new ConfigError(`RATELIMIT_API_KEYS role for "${id}" must be one of ${Config.ROLES.join(', ')}`);
      let policies = null;
      if (policyList) {
        policies = policyList.split('+').map((s) => s.trim()).filter(Boolean);
        for (const p of policies) if (!Config.POLICY_PATTERN.test(p)) throw new ConfigError(`RATELIMIT_API_KEYS key "${id}" names an invalid policy "${p}"`);
      }
      return { id, secret, role: /** @type {KeyRole} */ (role), policies };
    });
    if (keys.length === 0) throw new ConfigError('RATELIMIT_API_KEYS must contain at least one key');
    if (new Set(keys.map((k) => k.id)).size !== keys.length) throw new ConfigError('RATELIMIT_API_KEYS ids must be unique');
    if (new Set(keys.map((k) => k.secret)).size !== keys.length) throw new ConfigError('RATELIMIT_API_KEYS secrets must be unique');
    return keys;
  }
  /**
   * `AUDIT_URL` + `AUDIT_API_KEY`: both or neither. Empty = audit events are not forwarded.
   * @param {EnvReader} r
   */
  static #parseAudit(r) {
    const url = r.optional('AUDIT_URL').replace(/\/+$/, '');
    const apiKey = r.optional('AUDIT_API_KEY');
    if (!url && !apiKey) return null;
    if (!url || !apiKey) throw new ConfigError('AUDIT_URL and AUDIT_API_KEY must be set together');
    if (!/^https?:\/\/[^\s]+$/.test(url)) throw new ConfigError('AUDIT_URL must be an absolute http(s) URL');
    if (apiKey.length < 32) throw new ConfigError('AUDIT_API_KEY must be at least 32 characters');
    return { url, apiKey };
  }
}

/** Typed accessors over a raw environment map. */
class EnvReader {
  /** @param {NodeJS.ProcessEnv} env */
  constructor(env) {
    this.env = env;
  }

  /** @param {string} name */
  optional(name) {
    return this.env[name]?.trim() ?? '';
  }

  /** @param {string} name */
  required(name) {
    const v = this.optional(name);
    if (v === '') throw new ConfigError(`${name} is required`);
    return v;
  }

  /**
   * @param {string} name
   * @param {number} fallback
   * @param {{ min?: number, max?: number }} [range]
   */
  integer(name, fallback, range = {}) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
    const n = Number(raw);
    if (range.min !== undefined && n < range.min) throw new ConfigError(`${name} must be >= ${range.min}`);
    if (range.max !== undefined && n > range.max) throw new ConfigError(`${name} must be <= ${range.max}`);
    return n;
  }

  /**
   * @param {string} name
   * @param {boolean} fallback
   */
  boolean(name, fallback) {
    const raw = this.optional(name);
    if (raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new ConfigError(`${name} must be true or false, got "${raw}"`);
  }
}
