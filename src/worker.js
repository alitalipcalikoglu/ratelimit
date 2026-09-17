/**
 * Periodic housekeeping: stale counters, expired overrides, old statistics. Runs in the service
 * process; one instance per database.
 */
export class CleanupWorker {
  /**
   * @param {object} deps
   * @param {import('./domain/rate-limit-service.js').RateLimitService} deps.service
   * @param {number} deps.intervalMs
   * @param {import('./types.js').Logger} deps.logger
   */
  constructor({ service, intervalMs, logger }) {
    this.service = service;
    this.intervalMs = intervalMs;
    this.logger = logger;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  runOnce() {
    try {
      const r = this.service.cleanup();
      if (r.counters || r.overrides || r.decisions) this.logger.debug(r, 'cleanup');
      return r;
    } catch (err) {
      this.logger.error({ err }, 'cleanup failed');
      return null;
    }
  }
}
