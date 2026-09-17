# Middleware integration

A Fastify hook that checks every request against a policy, sets the standard `RateLimit-*` headers and answers 429. The client is a small class with `fetch`, a timeout and a fail-open switch.

## Client

```js
// ratelimit-client.js
export class RateLimitClient {
  /** @param {{ url: string, key: string, timeoutMs?: number }} opts */
  constructor({ url, key, timeoutMs = 300 }) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.timeoutMs = timeoutMs;
  }

  /** @param {string} path @param {object} body */
  async #post(path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error?.message ?? `ratelimit ${res.status}`), { code: data.error?.code, status: res.status });
    return data;
  }

  /** @param {{ policy: string, subject: string, cost?: number, peek?: boolean }} check */
  check(check) { return this.#post('/v1/check', check); }

  /** @param {{ policy: string, subject: string, cost?: number }[]} checks */
  checkMany(checks) { return this.#post('/v1/check/batch', { checks }); }

  /** @param {{ policy: string, subject: string, cost?: number, consumedAt?: string }} release */
  release(release) { return this.#post('/v1/release', release); }
}
```

## Hook

```js
import Fastify from 'fastify';
import { RateLimitClient } from './ratelimit-client.js';

const limiter = new RateLimitClient({ url: process.env.RATELIMIT_URL, key: process.env.RATELIMIT_API_KEY });
const app = Fastify();

app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/health')) return;
  const subject = request.headers['x-api-key-id'] ?? request.ip;   // whatever identifies the caller
  let d;
  try {
    d = await limiter.check({ policy: 'api', subject });
  } catch (err) {
    if (err.status === 404) throw err;                 // policy missing: a deployment mistake, surface it
    request.log.warn({ err }, 'ratelimit unavailable, failing open');
    return;                                            // fail open: the limiter is protection, not an authority
  }
  reply.header('ratelimit-limit', d.limit);
  reply.header('ratelimit-remaining', d.remaining);
  reply.header('ratelimit-reset', Math.max(0, Math.ceil((Date.parse(d.resetAt) - Date.now()) / 1000)));
  if (d.allowed) return;
  if (d.retryAfter !== null) reply.header('retry-after', d.retryAfter);
  return reply.code(429).send({ error: { code: d.blocked ? 'BLOCKED' : 'RATE_LIMITED', message: d.blocked ? 'this client is blocked' : `rate limit exceeded, retry in ${d.retryAfter} s` } });
});
```

## Fail open or closed

The example fails open: when the limiter cannot be reached within `timeoutMs`, the request goes through and a warning is logged. That is right for limits that protect capacity or cost. For limits that protect security (login attempts, one-time codes, signups) fail closed instead: return 503 and let the client retry. Decide per route, not per service.

## Which subject

| Goal | Subject |
|---|---|
| Per API key | key id from your auth layer |
| Per user | user id from the JWT |
| Per client address | `request.ip` (set `trustProxy` behind a proxy, or the subject becomes the proxy) |
| Per account for a shared endpoint | account id |
| Per phone number for SMS | E.164 number, hashed if the database must not hold it |

Combine goals with a [batch](batch.md): per key and per IP in one all-or-nothing call.

## Behind the gateway

When the gateway already identifies the caller, run the hook there once instead of in every service; the gateway needs a `check` role key. Services that are reachable without the gateway keep their own hook.
