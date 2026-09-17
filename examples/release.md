# Release

Checks happen before the work. When the work then fails for a reason that is not the caller's fault (upstream down, a lost database connection), the units should not stay spent. Release gives them back to the current windows.

```bash
rcurl -X POST $RL/v1/release -d '{ "policy": "export", "subject": "user_42", "cost": 1 }'
```

The response is the subject's state after the release, in the same shape as a check (`remaining` is what is left now).

Rules:

- The release lowers the counters of the current fixed windows, never below zero. Units spent in a window that already rolled over cannot be returned (they fade out on their own).
- Release only what you consumed, once. The service has no memory of individual checks; a wrong release is a free request.
- Do not release on the caller's own failures (validation errors, 4xx). Rate limits count attempts, not successes, and releasing on user errors would let a client probe for free.

Pattern in a handler:

```js
const decision = await limiter.check({ policy: 'export', subject: userId });
if (!decision.allowed) return reply.code(429).send(...);
try {
  await runExport();
} catch (err) {
  if (isInfrastructureFailure(err)) await limiter.release({ policy: 'export', subject: userId });
  throw err;
}
```
