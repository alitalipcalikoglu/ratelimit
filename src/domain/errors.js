/**
 * Domain error with a stable machine-readable code and the HTTP status the API maps it to.
 */
export class RateLimitError extends Error {
  /** @type {Record<string, number>} */
  static STATUS = {
    POLICY_NOT_FOUND: 404,
    POLICY_EXISTS: 409,
    OVERRIDE_NOT_FOUND: 404,
    INVALID_LIMITS: 400,
    COST_TOO_HIGH: 400,
    DUPLICATE_CHECK: 400,
    UNKNOWN_WINDOW: 400,
    FORBIDDEN: 403,
  };

  /**
   * @param {keyof typeof RateLimitError.STATUS} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
    this.statusCode = RateLimitError.STATUS[code];
    this.details = details;
  }
}
