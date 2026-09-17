/**
 * Shared JSDoc typedefs for the ratelimit service. No runtime exports.
 */

/** @typedef {'check'|'read'|'write'|'readwrite'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 * @property {string[]|null} policies   Policies this key may touch; null = all.
 */

/**
 * Plain values accepted by the `Config` constructor.
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {number} maxLimits
 * @property {number} maxWindowSec
 * @property {number} maxCost
 * @property {number} maxBatch
 * @property {number} cleanupIntervalSec
 * @property {number} statsRetentionDays
 */

/** @typedef {import('./config.js').Config} Config */

/**
 * One window of a policy: at most `limit` units per `window` seconds. `limit` 0 blocks.
 * @typedef {{ window: number, limit: number }} Limit
 */

/**
 * @typedef {object} PolicyRow
 * @property {string} name
 * @property {string} description
 * @property {string} limits        JSON {@link Limit}[] sorted by window.
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} OverrideRow
 * @property {string} policy
 * @property {string} subject
 * @property {string} limits        JSON {@link Limit}[].
 * @property {string} note
 * @property {number|null} expires_at
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} CheckInput
 * @property {string} policy
 * @property {string} subject
 * @property {number} [cost]        Units to consume, default 1.
 */

/**
 * State of one window for one subject at one instant.
 * @typedef {object} LimitState
 * @property {number} window
 * @property {number} limit
 * @property {number} used          Sliding-window estimate.
 * @property {number} remaining
 * @property {boolean} allowed      Whether `cost` more units fit.
 * @property {number} resetAt       End of the current window, ms.
 * @property {number|null} retryAfter  Seconds until `cost` units fit; null when the window is blocked.
 */

/**
 * @typedef {object} Decision
 * @property {string} policy
 * @property {string} subject
 * @property {boolean} allowed
 * @property {number} cost
 * @property {'policy'|'override'} source
 * @property {boolean} blocked
 * @property {number} limit         Of the most restrictive window.
 * @property {number} remaining
 * @property {number} resetAt
 * @property {number|null} retryAfter
 * @property {LimitState[]} limits
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
