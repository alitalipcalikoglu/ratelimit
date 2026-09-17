import { Config } from './config.js';
import { Database } from './db.js';
import { RateLimitService } from './domain/rate-limit-service.js';
import { RateLimitApi } from './http/rate-limit-api.js';
import { CounterStore } from './store/counter-store.js';
import { OverrideStore } from './store/override-store.js';
import { PolicyStore } from './store/policy-store.js';
import { CleanupWorker } from './worker.js';

/** Composition root: wires configuration, storage, domain, HTTP and the cleanup worker; owns the process lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.db = new Database(config.dbPath);
    this.policies = new PolicyStore(this.db);
    this.overrides = new OverrideStore(this.db);
    this.counters = new CounterStore(this.db);
    this.service = new RateLimitService({ db: this.db, policies: this.policies, overrides: this.overrides, counters: this.counters, options: config });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {CleanupWorker|null} */
    this.worker = null;
    this.shuttingDown = false;
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const api = new RateLimitApi({ config, service: this.service, policies: this.policies, overrides: this.overrides, counters: this.counters, db: this.db });
    const app = await api.build();
    this.app = app;
    this.#installSignalHandlers(app.log);
    await app.listen({ port: config.port, host: config.host });
    this.worker = new CleanupWorker({ service: this.service, intervalMs: config.cleanupIntervalSec * 1000, logger: app.log });
    this.worker.runOnce();
    this.worker.start();
    app.log.info({ tls: config.tls !== null, policies: this.policies.all().length }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
  }

  /** @param {string} reason */
  async shutdown(reason) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = /** @type {import('./types.js').Logger} */ (this.app?.log ?? console);
    log.info({ reason }, 'shutting down');
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 30_000).unref();
    try {
      this.worker?.stop();
      await this.app?.close();
      this.db.close();
      clearTimeout(forceExit);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  }

  /** @param {import('./types.js').Logger} log */
  #installSignalHandlers(log) {
    process.on('SIGTERM', () => this.shutdown('SIGTERM'));
    process.on('SIGINT', () => this.shutdown('SIGINT'));
    process.on('unhandledRejection', (reason) => {
      log.fatal({ err: reason }, 'unhandled rejection');
      this.shutdown('unhandledRejection');
    });
    process.on('uncaughtException', (err) => {
      log.fatal({ err }, 'uncaught exception');
      process.exit(1);
    });
  }
}
