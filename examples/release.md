# Release

Checks happen before the work. When the work then fails for a reason that is not the caller's fault (upstream down, a lost database connection), the units should not stay spent. Release gives them back to the window that was actually consumed — pass back the check's `consumedAt` so a release arriving after a window boundary still credits the right bucket.

```bash
rcurl -X POST $RL/v1/check -d '{ "policy": "export", "subject": "user_42" }'
# { "allowed": true, "remaining": 4, "consumedAt": "2026-09-17T10:00:03.000Z", ... }

rcurl -X POST $RL/v1/release -d '{ "policy": "export", "subject": "user_42", "cost": 1, "consumedAt": "2026-09-17T10:00:03.000Z" }'
```

The response is the subject's state after the release, in the same shape as a check (`remaining` is what is left now).

Rules:

- Pass back the `consumedAt` the check returned. The release decrements the window that instant falls in, not whichever window is current when the release arrives — so a release delayed past a window boundary (a slow upstream call, a retry loop) still credits the request that was actually released, not an unrelated or empty window.
- `consumedAt` is optional. Omitting it releases against the *current* window, same as the check happened right now — correct only when release happens inside the same window as the check, and mainly there for a caller that never stores `consumedAt` and only releases immediately.
- The release is clamped at zero, never below. Units spent in a window that already rolled over, released without `consumedAt`, cannot be returned this way (they fade out on their own).
- Release only what you consumed, once. The service has no memory of individual checks; a wrong release is a free request, and releasing twice for one check gives back twice as much.
- Do not release on the caller's own failures (validation errors, 4xx). Rate limits count attempts, not successes, and releasing on user errors would let a client probe for free.

Pattern in a handler:

```js
const decision = await limiter.check({ policy: 'export', subject: userId });
if (!decision.allowed) return reply.code(429).send(...);
try {
  await runExport();
} catch (err) {
  if (isInfrastructureFailure(err)) await limiter.release({ policy: 'export', subject: userId, consumedAt: decision.consumedAt });
  throw err;
}
```
