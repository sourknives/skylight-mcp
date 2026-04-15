# Skylight OAuth Token Persistence — Design

**Status:** Draft — pending review
**Date:** 2026-04-15
**Branch:** `claude/cranky-bartik`

## Problem

In early 2026, Skylight migrated from `POST /api/sessions` (email/password) to a Doorkeeper OAuth2 flow. The legacy endpoint now returns `"This version of Skylight is no longer supported"`, so `skylight-mcp` cannot authenticate at all on `main` @ `5d7f14e`.

An in-progress rewrite on the `main` checkout (uncommitted) introduces a refresh-token grant flow:

```
POST /oauth/token
{ grant_type: "refresh_token", refresh_token, client_id, fingerprint }
```

The rewrite calls this endpoint correctly and Bearer-authenticates subsequent API requests. However, its docstring claims "Skylight's Doorkeeper is NOT configured to invalidate refresh tokens on use (verified empirically)," and the code ignores the rotated `refresh_token` in the response body, re-using the env-seeded token on every refresh.

**Empirical testing on 2026-04-15 contradicts that claim.** A fresh refresh token worked exactly once. A second `/oauth/token` call seconds later — same token, same client_id, same fingerprint — returned:

```json
{"error":"invalid_grant","error_description":"The provided authorization grant is invalid, expired, revoked, does not match the redirection URI used in the authorization request, or was issued to another client."}
```

Rotation is enforced. Every refresh consumes the current refresh token and returns a new one that must be persisted. The current in-progress code will work exactly once per process startup (cold access-token acquisition) and then break permanently on the next startup, because the env var still holds the now-revoked seed.

**Probed alternatives, all infeasible:**

| Approach | Result |
|---|---|
| `grant_type=password` on `/oauth/token` | `unsupported_grant_type` — disabled |
| `POST /auth/session` (web login) + session cookie → `/api/user` | 401 "Invalid token" — session cookies don't grant API access |
| `/oauth/authorize` authorization-code flow | 400 — requires a pre-registered `redirect_uri` the mobile client uses. Not discoverable without decompiling the mobile app or proxying its traffic |

The only supported grant on `/oauth/token` is `refresh_token`. The only way the MCP can obtain API access is to be seeded with a refresh token captured out-of-band from the mobile app, then rotate it correctly.

## Goal

Make `skylight-mcp` authenticate reliably across process restarts by persisting and rotating the refresh token correctly, without requiring the user to manually re-bootstrap except after genuine server-side revocation.

## Non-goals

- **Programmatic bootstrap from email/password.** Infeasible without reverse-engineering the mobile OAuth client. Deferred indefinitely.
- **Multi-process coordination.** The MCP is spawned once by Claude Desktop and lives for the lifetime of that desktop session. Users who run competing processes (spot-check scripts, second IDE) will burn the refresh token and must re-bootstrap. Documented, not designed around.
- **In-session reauth via an MCP tool.** Recovery from a dead cache is "edit env var + restart Claude Desktop." No `skylight_reauth` tool.
- **Hot-reload of config.** Env vars are read once at startup. Config changes require a restart.
- **Retry / backoff on refresh failures.** Rotation semantics make retries unsafe — a retry after a server-side success leaves the caller with a dead token. Fail fast.

## Design

### Architecture

One new module and edits to two existing modules:

| File | Change |
|---|---|
| `src/auth/token-store.ts` | **New.** Pure I/O for the cache file. No HTTP, no OAuth knowledge. |
| `src/auth/token-manager.ts` | **New.** Stateful orchestrator. Owns refresh dedup, seed-vs-cache selection, expiry checks. |
| `src/api/auth.ts` | **Patched.** `refreshAccessToken()` return type gains `refreshToken`. Docstring corrected. Dead email/password functions removed. |
| `src/api/client.ts` | **Patched.** `SkylightClient` delegates all auth to `TokenManager`. In-line auth state deleted. |
| `src/config.ts` | **Patched.** Adds optional `cacheDir` from `SKYLIGHT_CACHE_DIR`. |
| `src/utils/errors.ts` | **Patched.** Adds `TokenRefreshError` class. |

### Data flow on startup

```
SkylightClient.initialize()
  └─ tokenManager.getAccessToken()
       ├─ cached = TokenStore.load()  →  CachedToken | null
       ├─ if cached.seedHash !== sha256(env.refreshToken):
       │     TokenStore.clear(); cached = null        (env var rotated)
       ├─ if cached && cached.expiresAt - now > 5min:
       │     return cached.accessToken                (hot path, no network)
       └─ refreshToken = cached?.refreshToken ?? env.refreshToken
          result = refreshAccessToken({ clientId, refreshToken, fingerprint })
          TokenStore.save({ refreshToken: result.refreshToken,
                            accessToken: result.accessToken,
                            expiresAt: result.expiresAt,
                            seedHash: sha256(env.refreshToken) })
          return result.accessToken
  └─ loadSubscriptionStatus()  (unchanged /api/user call)
```

### `TokenStore` (`src/auth/token-store.ts`)

Pure file I/O. No imports from `api/`.

```ts
export interface CachedToken {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;      // epoch ms
  seedHash: string;       // sha256 hex of env.refreshToken at last seed
}

export function getCachePath(): string;
export function load(): CachedToken | null;
export function save(token: CachedToken): void;
export function clear(): void;
export function hashSeed(envToken: string): string;
```

**Path resolution** (`getCachePath`, resolved once at module load):

1. If `SKYLIGHT_CACHE_DIR` env var set → `${dir}/token.json`
2. Else by `process.platform`:
   - `win32` → `${APPDATA ?? homedir()/AppData/Roaming}/skylight-mcp/token.json`
   - `darwin` → `${homedir()}/Library/Application Support/skylight-mcp/token.json`
   - other → `${XDG_CONFIG_HOME ?? homedir()/.config}/skylight-mcp/token.json`

**Atomic save:**

```ts
mkdirSync(dirname(path), { recursive: true });
const tmp = `${path}.${process.pid}.tmp`;
writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
renameSync(tmp, path);
```

`mode: 0o600` sets owner-only permissions on POSIX at file creation. On Windows, the parent directory under `%APPDATA%` inherits the user profile ACL, which is already user-only — no chmod needed.

**`load()` error handling:**

- `ENOENT` → `null` (cold start)
- JSON parse error → warn to stderr, return `null`
- Missing required fields (schema drift) → warn, return `null`
- Any other error (permissions, disk) → rethrow

### `TokenManager` (`src/auth/token-manager.ts`)

```ts
export interface TokenManagerConfig {
  clientId: string;
  envRefreshToken: string;
  fingerprint: string;
}

export class TokenManager {
  private cached: CachedToken | null = null;
  private refreshInFlight: Promise<CachedToken> | null = null;
  constructor(private readonly config: TokenManagerConfig) {}

  async getAccessToken(): Promise<string>;
  async forceRefresh(): Promise<string>;
}
```

**`getAccessToken()`:**

1. Lazy-load `this.cached` from `TokenStore` on first call
2. If `this.cached.seedHash !== hashSeed(config.envRefreshToken)` → `TokenStore.clear()`, set `this.cached = null` (user rotated the env var; treat as fresh seed)
3. If `this.cached && this.cached.expiresAt - Date.now() > 5*60*1000` → return `this.cached.accessToken`
4. Otherwise call `doRefresh(this.cached?.refreshToken ?? config.envRefreshToken)`, return its accessToken

**`doRefresh(refreshToken)`** — deduplicated via `this.refreshInFlight`:

- If `refreshInFlight` is non-null, await it and return the result. Prevents double-refresh when two code paths hit an expired token simultaneously.
- Otherwise set `refreshInFlight`, call `refreshAccessToken()`, persist via `TokenStore.save()`, update `this.cached`, clear `refreshInFlight`.
- On `invalid_grant`: attempt one fallback with `config.envRefreshToken` if it differs from the token we just tried (near-always a no-op because of the seedHash check, but cheap insurance). If that also fails, throw `TokenRefreshError { code: "invalid_grant", stage: "cached" | "seed" }`.
- On network / 5xx: throw `TokenRefreshError { code: "network", cause }`.

**`forceRefresh()`** — called from the 401 retry path in `SkylightClient.request()`. Same as the refresh branch of `getAccessToken`, but unconditional (ignores the 5-minute expiry check).

### `refreshAccessToken()` patch (`src/api/auth.ts`)

Minimal change. The HTTP call body stays the same; the return type adds `refreshToken`:

```ts
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;   // NEW — the rotated token from the response
  expiresAt: number;
}
```

Docstring replaces the non-rotation claim with a correction: "Rotation IS enforced. Callers MUST persist `refreshToken` from the response and use it on the next refresh. Empirically verified 2026-04-15."

Dead functions from the email/password era (`login`, `getAuth`, `clearAuthCache`, etc., if still present) get removed.

### `SkylightClient` slim-down (`src/api/client.ts`)

**Deleted fields and methods:**

- `resolvedToken`, `resolvedUserId`, `loginPromise`, `getCredentials()`
- Basic-auth branch in `getAuthHeader()` (OAuth-only post-migration)
- `authType` field in `src/config.ts` (confirmed present at lines 14, 40, 49 of the committed code) — the pre-OAuth manual-token path is dead. `SKYLIGHT_AUTH_TYPE` env var also removed from `.env.example`.

**Replaced with:**

```ts
private tokenManager: TokenManager;  // built in constructor from config

private async getAuthHeader(): Promise<string> {
  const token = await this.tokenManager.getAccessToken();
  return `Bearer ${token}`;
}

async initialize(): Promise<void> {
  await this.tokenManager.getAccessToken();
  await this.loadSubscriptionStatus();  // unchanged /api/user call
}
```

**401 retry path** in `request()`:

```ts
if (response.status === 401 && !isRetry) {
  await this.tokenManager.forceRefresh();
  return this.request(endpoint, options, true);
}
```

### Config addition (`src/config.ts`)

Add optional `cacheDir?: string` parsed from `SKYLIGHT_CACHE_DIR`. No schema changes otherwise — `clientId`, `refreshToken`, `fingerprint`, `frameId` already match what `TokenManager` needs.

### Error handling

Three failure modes, each with a tagged error and specific stderr message.

**Cold start, env seed is dead** — `TokenRefreshError { code: "invalid_grant", stage: "seed" }`:

```
[auth] refresh failed: invalid_grant
Skylight auth failed: refresh token is invalid or revoked.
The token in SKYLIGHT_REFRESH_TOKEN cannot be used to log in.
Re-capture a refresh token from the Skylight mobile app and
update SKYLIGHT_REFRESH_TOKEN in claude_desktop_config.json,
then restart Claude Desktop.
```

MCP exits non-zero. Claude Desktop surfaces the failure in its MCP status indicator.

**Warm start, cached token is dead** — `TokenRefreshError { code: "invalid_grant", stage: "cached" }`:

Same recovery message, plus:

> "(Your cached token at `<path>` is left in place for debugging. It will be replaced automatically once you update SKYLIGHT_REFRESH_TOKEN.)"

The cache file is NOT auto-deleted. When the user edits the env var and restarts, the seedHash mismatch in `getAccessToken()` clears it next run.

**Mid-session 401** — `AuthenticationError` (existing class):

Handled entirely inside `client.request()`. `forceRefresh()` + retry once. If the retry also 401s, propagates as a tool call failure (not an MCP crash). Extremely rare in practice — means the server clock drifted, our expiry math is wrong, or the token got revoked mid-session.

**Network / 5xx during refresh** — `TokenRefreshError { code: "network", cause }`:

No retry. Fail fast. On startup this kills the MCP; mid-session it surfaces as a tool call failure. Claude Desktop restart retries from scratch.

### Logging

All to stderr, one line each, no token material in any message:

- `[auth] cache hit; access token valid for Xs`
- `[auth] cache seed mismatch; re-seeding from env`
- `[auth] refreshing access token`
- `[auth] refresh ok; expires in Xs`
- `[auth] refresh failed: <code>`

## Testing

Unit tests only. No live-API integration in the suite. `scripts/spot-check.mjs` remains the manual end-to-end check and is not run in CI.

**`tests/token-store.test.ts`:**

- `save` → `load` round-trip preserves all fields
- `load` returns null for missing file, corrupt JSON, schema drift (missing fields)
- `load` rethrows on non-ENOENT / non-parse errors
- `clear` is idempotent
- `hashSeed` is deterministic
- `getCachePath` honors `SKYLIGHT_CACHE_DIR` override
- `getCachePath` returns platform-correct default for mocked `process.platform` values
- Saved file has mode `0o600` on POSIX (skipped on Windows)

**`tests/token-manager.test.ts`** (mocks `refreshAccessToken` and `TokenStore`):

- Cold start, no cache → uses env token, saves cache with correct `seedHash`
- Warm start, valid cached access token → no network call
- Warm start, expired access token → refreshes, saves new cache
- Warm start, `expiresAt - now == 4min` → refreshes (within 5-minute headroom)
- Env var rotated → cache cleared, fresh seed path taken
- Concurrent `getAccessToken()` calls → exactly one `refreshAccessToken` call (dedup)
- Rotated `refreshToken` from the mock response is the value persisted (bug-fix regression test)
- `invalid_grant` with cached token differing from env → attempts env fallback once, persists success
- `invalid_grant` with no useful fallback → throws `TokenRefreshError { stage: "seed" | "cached" }`, does not call `save`
- Network error → throws `TokenRefreshError { code: "network" }`, does not call `save`
- `forceRefresh()` ignores the 5-minute expiry headroom

**`tests/errors.test.ts`:**

Add coverage for `TokenRefreshError` construction and fields.

**`tests/client.test.ts`** (new file; verified absent as of 2026-04-15):

Mock `TokenManager`. Verify:

- `getAuthHeader()` returns `Bearer <token>`
- 401 → retry: mock returns 401 once then 200, `forceRefresh` called exactly once
- 401 → 401: second 401 propagates, no infinite loop
- `initialize()` calls both `getAccessToken` and `loadSubscriptionStatus`

## Acceptance criteria

1. Cold start with a valid env refresh token: MCP logs in, `scripts/spot-check.mjs` passes all base + plus tools (modulo test-script bugs unrelated to auth)
2. Process restart within 2 hours of a successful login: no network call to `/oauth/token` (cache hit, same access token reused)
3. Process restart after 2 hours: one refresh call, new cached token persisted, spot-check passes
4. User edits `SKYLIGHT_REFRESH_TOKEN` in `claude_desktop_config.json` and restarts: old cache is cleared automatically via seedHash mismatch; new token takes effect on first API call
5. User deletes the cache file manually: next startup re-seeds from env and recreates it
6. Running two MCP processes concurrently: first one wins, second one fails with `TokenRefreshError { code: "invalid_grant" }` — documented, not auto-recovered
7. All existing unit tests (`tests/dates.test.ts`, `tests/errors.test.ts`) continue to pass
8. All new unit tests pass
9. `npm run lint` and `npm run typecheck` clean

## Migration notes

The uncommitted rewrite on the `main` checkout is mostly correct and should be salvaged, not discarded.

**Salvage unchanged:**

- The `POST /oauth/token` call in `refreshAccessToken()` (HTTP shape is right)
- The config schema additions (`clientId` / `refreshToken` / `fingerprint`)
- The `.env.example` instructions for scraping the seed values from the mobile app

**Fix during migration:**

- `refreshAccessToken()` return type — add `refreshToken` field, persist it
- `refreshAccessToken()` docstring — delete the non-rotation claim, replace with the truth
- `SkylightClient` auth state — replace in-line refresh logic with `TokenManager` + `TokenStore`
- `src/config.ts` — remove the legacy `authType` field and `SKYLIGHT_AUTH_TYPE` env handling (dead since the OAuth migration)
- Dead legacy functions in `src/api/auth.ts` — `login()`, `getAuth()`, `clearAuthCache()` if still present after the uncommitted rewrite lands

**Commit order (guidance for the plan):**

1. Commit the uncommitted rewrite's salvageable parts on top of `5d7f14e` (tests still red — expected)
2. Add `TokenStore` module + tests (green)
3. Add `TokenManager` module + tests (green)
4. Wire `SkylightClient` to `TokenManager`, delete dead auth state (green, spot-check should pass)
5. Update `.env.example` and README with cache-file notes
