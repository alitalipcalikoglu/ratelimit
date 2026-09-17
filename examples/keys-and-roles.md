# API keys and roles

`RATELIMIT_API_KEYS` lists callers as `id:secret[:role[:policies]]`, comma separated.

```
RATELIMIT_API_KEYS=console:9f2c…,gateway:41ab…:check,shop-backend:c07e…:check:api+login,ops:77d0…:read
```

| Role | May call |
|---|---|
| `check` | `POST /v1/check`, `POST /v1/check/batch`, `POST /v1/release` |
| `read` | `GET` on policies, overrides, subjects, top, stats, `/metrics` |
| `write` | create, change and delete policies and overrides; reset a subject's usage |
| `readwrite` (default) | everything |

Services that enforce limits get `check`; dashboards get `read`; the console gets `readwrite`. A `check` key cannot read policies or usage, so a leaked service key reveals nothing about other subjects.

## Scoping a key to policies

The fourth field names the policies a key may touch, joined with `+`:

```
shop-backend:c07e…:check:api+login
```

The key may check `api` and `login` and nothing else. A `readwrite` key with a scope sees only its policies in lists and cannot create policies outside the scope. Policy names in scopes are not checked against existing policies, so keys can be issued before the policy exists.

```bash
curl -s -H "Authorization: Bearer $SHOP" -H "Content-Type: application/json" $RL/v1/check -d '{ "policy": "internal", "subject": "x" }'
```

```json
{ "error": { "code": "FORBIDDEN", "message": "this API key has no access to policy \"internal\"" } }
```

## The service's own rate limit

`RATE_LIMIT_MAX` (6 000 per minute per key) protects the service itself; a busy gateway may need more. Exceeding it answers `429 RATE_LIMITED` with `retry-after`. Do not confuse it with the policies the service manages.

## Error codes

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Body or query does not match the schema (`details` lists the paths) |
| 400 | `INVALID_JSON` | Body is not JSON |
| 400 | `INVALID_LIMITS` | Empty limits, duplicate window, out of range, bad `expiresAt` |
| 400 | `COST_TOO_HIGH` | Cost above `MAX_COST` or above a window's limit |
| 400 | `DUPLICATE_CHECK` | Same policy and subject twice in a batch, or too many entries |
| 400 | `UNKNOWN_WINDOW` | `top?window=` is not a window of the policy |
| 401 | `UNAUTHORIZED` | Missing or unknown bearer secret |
| 403 | `FORBIDDEN` | Role or policy scope does not allow the call |
| 404 | `POLICY_NOT_FOUND`, `OVERRIDE_NOT_FOUND`, `NOT_FOUND` | Unknown policy, override or route |
| 409 | `POLICY_EXISTS` | Name taken |
| 429 | `RATE_LIMITED` | The service's own per-key limit |
