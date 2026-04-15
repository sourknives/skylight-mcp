# Skylight OAuth Token Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead email/password auth path in `skylight-mcp` with a Doorkeeper OAuth2 refresh-token flow that persists and rotates the refresh token across process restarts.

**Architecture:** Introduce two new modules — `TokenStore` (pure file I/O for a cache file) and `TokenManager` (stateful orchestrator: loads cache, checks expiry, dedupes concurrent refreshes, rotates refresh tokens). `SkylightClient` delegates all auth to `TokenManager`; `refreshAccessToken()` in `src/api/auth.ts` is rewritten to call `POST /oauth/token` and return the rotated `refreshToken` field. All legacy email/password / manual-token code paths are deleted.

**Tech Stack:** TypeScript (ES2022, NodeNext ESM), Node 18+, vitest, Zod.

**Reference spec:** [2026-04-15-skylight-oauth-token-persistence-design.md](../specs/2026-04-15-skylight-oauth-token-persistence-design.md)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/auth/token-store.ts` | **Create** | Pure file I/O for `CachedToken` — load, save, clear, path resolution, seed hashing. No HTTP, no OAuth knowledge. |
| `src/auth/token-manager.ts` | **Create** | Stateful orchestrator. Owns cached token, in-flight refresh dedup, seed-vs-cache selection, expiry check, env-var rotation detection. |
| `src/api/auth.ts` | **Rewrite** | Replace `login()` / `getAuth()` / `clearAuthCache()` with `refreshAccessToken()` that hits `POST /oauth/token` and returns `{accessToken, refreshToken, expiresAt}`. |
| `src/api/client.ts` | **Modify** | Delete in-line auth state (`resolvedToken`, `resolvedUserId`, `loginPromise`, `getCredentials()`, Basic-auth branch). Delegate to `TokenManager`. 401 retry calls `forceRefresh()`. |
| `src/config.ts` | **Modify** | Remove email/password/token/authType. Add required `clientId`, `refreshToken`, `fingerprint`. Add optional `cacheDir`. |
| `src/utils/errors.ts` | **Modify** | Add `TokenRefreshError` class tagged with `code` and `stage`. |
| `.env.example` | **Modify** | Document the new env vars and how to capture them from the mobile app. |
| `tests/token-store.test.ts` | **Create** | Unit tests for file I/O, path resolution, error handling. |
| `tests/token-manager.test.ts` | **Create** | Unit tests for cache lifecycle, dedup, rotation, error paths. Mocks `refreshAccessToken` and `TokenStore`. |
| `tests/client.test.ts` | **Create** | Unit tests for `SkylightClient` auth header + 401 retry. Mocks `TokenManager`. |
| `tests/errors.test.ts` | **Modify** | Add coverage for `TokenRefreshError`. |
| `tests/auth.test.ts` | **Create** | Unit tests for `refreshAccessToken()` with mocked `fetch`. |

---

## Task 1: Add `TokenRefreshError` class and tests

**Files:**
- Modify: `src/utils/errors.ts`
- Modify: `tests/errors.test.ts`

- [ ] **Step 1: Add failing test for `TokenRefreshError` construction**

Append to `tests/errors.test.ts` before the final closing `});`:

```ts
  describe("TokenRefreshError", () => {
    it("creates invalid_grant error with stage", () => {
      const error = new TokenRefreshError({ code: "invalid_grant", stage: "seed" });
      expect(error.code).toBe("TOKEN_REFRESH_FAILED");
      expect(error.refreshErrorCode).toBe("invalid_grant");
      expect(error.stage).toBe("seed");
      expect(error.name).toBe("TokenRefreshError");
      expect(error.recoverable).toBe(true);
    });

    it("creates network error with cause", () => {
      const cause = new Error("ECONNREFUSED");
      const error = new TokenRefreshError({ code: "network", cause });
      expect(error.refreshErrorCode).toBe("network");
      expect(error.cause).toBe(cause);
      expect(error.stage).toBeUndefined();
    });

    it("is formatted with recovery instructions by formatErrorForMcp", () => {
      const error = new TokenRefreshError({ code: "invalid_grant", stage: "seed" });
      const formatted = formatErrorForMcp(error);
      expect(formatted).toContain("refresh token");
      expect(formatted).toContain("SKYLIGHT_REFRESH_TOKEN");
    });
  });
```

Also update the imports at the top of the file to include `TokenRefreshError`:

```ts
import {
  SkylightError,
  AuthenticationError,
  ConfigurationError,
  NotFoundError,
  RateLimitError,
  ParseError,
  TokenRefreshError,
  formatErrorForMcp,
} from "../src/utils/errors.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- errors`
Expected: FAIL — "TokenRefreshError is not exported from '../src/utils/errors.js'"

- [ ] **Step 3: Add `TokenRefreshError` to `src/utils/errors.ts`**

Append after the `ParseError` class (before `formatErrorForMcp`):

```ts
/**
 * OAuth refresh-token flow failed. Recovery depends on `code`:
 * - invalid_grant: refresh token is dead. User must edit SKYLIGHT_REFRESH_TOKEN and restart.
 * - network: transient. Claude Desktop restart retries from scratch.
 */
export type TokenRefreshErrorCode = "invalid_grant" | "network";
export type TokenRefreshStage = "seed" | "cached";

export interface TokenRefreshErrorInit {
  code: TokenRefreshErrorCode;
  stage?: TokenRefreshStage;
  cause?: unknown;
}

export class TokenRefreshError extends SkylightError {
  public readonly refreshErrorCode: TokenRefreshErrorCode;
  public readonly stage?: TokenRefreshStage;
  public override readonly cause?: unknown;

  constructor(init: TokenRefreshErrorInit) {
    const message =
      init.code === "invalid_grant"
        ? `OAuth refresh failed: invalid_grant${init.stage ? ` (stage: ${init.stage})` : ""}`
        : `OAuth refresh failed: network error`;
    super(message, "TOKEN_REFRESH_FAILED", 401, true);
    this.name = "TokenRefreshError";
    this.refreshErrorCode = init.code;
    this.stage = init.stage;
    this.cause = init.cause;
  }
}
```

Then add a branch to `formatErrorForMcp` above the `AuthenticationError` branch:

```ts
  if (error instanceof TokenRefreshError) {
    if (error.refreshErrorCode === "invalid_grant") {
      const cachedNote =
        error.stage === "cached"
          ? "\n\n(Your cached token is left in place for debugging. It will be replaced automatically once you update SKYLIGHT_REFRESH_TOKEN.)"
          : "";
      return `Skylight auth failed: refresh token is invalid or revoked.
The token in SKYLIGHT_REFRESH_TOKEN cannot be used to log in.
Re-capture a refresh token from the Skylight mobile app and
update SKYLIGHT_REFRESH_TOKEN in claude_desktop_config.json,
then restart Claude Desktop.${cachedNote}`;
    }
    return `Skylight auth failed: network error while refreshing token.
Check your internet connection and restart Claude Desktop to retry.`;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- errors`
Expected: PASS — all `TokenRefreshError` tests green, existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/errors.ts tests/errors.test.ts
git commit -m "feat(errors): add TokenRefreshError for OAuth refresh failures"
```

---

## Task 2: Rewrite `src/config.ts` for OAuth

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

No tests in this task — the config module is covered by downstream modules that import it. We verify via typecheck + the existing test suite.

- [ ] **Step 1: Replace `src/config.ts` contents**

Full replacement:

```ts
import { z } from "zod";

const ConfigSchema = z.object({
  // Required OAuth credentials (scraped out-of-band from the Skylight mobile app)
  clientId: z.string().min(1, "SKYLIGHT_CLIENT_ID is required"),
  refreshToken: z.string().min(1, "SKYLIGHT_REFRESH_TOKEN is required"),
  fingerprint: z.string().min(1, "SKYLIGHT_FINGERPRINT is required"),

  // Required household identifier
  frameId: z.string().min(1, "SKYLIGHT_FRAME_ID is required"),

  // Optional
  cacheDir: z.string().min(1).optional(),
  timezone: z.string().default("America/New_York"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    clientId: process.env.SKYLIGHT_CLIENT_ID,
    refreshToken: process.env.SKYLIGHT_REFRESH_TOKEN,
    fingerprint: process.env.SKYLIGHT_FINGERPRINT,
    frameId: process.env.SKYLIGHT_FRAME_ID,
    cacheDir: process.env.SKYLIGHT_CACHE_DIR,
    timezone: process.env.SKYLIGHT_TIMEZONE || "America/New_York",
  });

  if (!result.success) {
    const errors = result.error.errors.map((e) => `  - ${e.message}`).join("\n");
    console.error(`
Skylight MCP Server - Configuration Error

Missing or invalid configuration:
${errors}

Required environment variables:
  SKYLIGHT_CLIENT_ID      - OAuth client ID (from mobile app)
  SKYLIGHT_REFRESH_TOKEN  - OAuth refresh token (from mobile app)
  SKYLIGHT_FINGERPRINT    - Device fingerprint (from mobile app)
  SKYLIGHT_FRAME_ID       - Your frame/household ID

Optional:
  SKYLIGHT_CACHE_DIR      - Directory for persisted token cache (default: platform-specific)
  SKYLIGHT_TIMEZONE       - Timezone for dates (default: America/New_York)

To capture OAuth credentials:
1. Install a TLS proxy (mitmproxy, Charles, etc.) on your phone
2. Log in to the Skylight mobile app
3. Find the POST /oauth/token request
4. Copy the client_id, refresh_token, and fingerprint from the request body
`);
    process.exit(1);
  }

  return result.data;
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

// Test-only: reset the singleton so tests can re-parse env vars.
export function _resetConfigForTests(): void {
  cachedConfig = null;
}
```

- [ ] **Step 2: Replace `.env.example` contents**

Full replacement:

```
# Skylight MCP Server Configuration
# Copy this file to .env and fill in your values

# ============================================
# REQUIRED — OAuth credentials
# ============================================
# Capture these from the Skylight mobile app using a TLS proxy
# (mitmproxy, Charles, etc.). Look for a POST /oauth/token request
# and copy the client_id, refresh_token, and fingerprint fields.

SKYLIGHT_CLIENT_ID=your_client_id_here
SKYLIGHT_REFRESH_TOKEN=your_refresh_token_here
SKYLIGHT_FINGERPRINT=your_device_fingerprint_here

# Your Skylight frame (household) ID
# Found in API request URLs like /api/frames/{frameId}/chores
SKYLIGHT_FRAME_ID=your_frame_id_here

# ============================================
# OPTIONAL
# ============================================

# Directory for persisted token cache. If unset, defaults to:
#   Windows: %APPDATA%\skylight-mcp\
#   macOS:   ~/Library/Application Support/skylight-mcp/
#   Linux:   ${XDG_CONFIG_HOME:-~/.config}/skylight-mcp/
# SKYLIGHT_CACHE_DIR=/custom/path

# Default timezone for date operations
SKYLIGHT_TIMEZONE=America/New_York
```

- [ ] **Step 3: Verify typecheck breaks in the expected places**

Run: `npm run typecheck`
Expected: FAIL — errors in `src/api/client.ts` referencing `usesEmailAuth`, `config.email`, `config.token`, `config.authType`, etc. This is expected; those files will be fixed in Tasks 4 and 7.

Do NOT commit yet. Continue to Task 3 (errors.ts was already done; config leaves the tree red until Task 7).

---

## Task 3: Create `TokenStore` — tests first

**Files:**
- Create: `tests/token-store.test.ts`
- Create: `src/auth/token-store.ts`

- [ ] **Step 1: Write the full failing test file**

Create `tests/token-store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  load,
  save,
  clear,
  hashSeed,
  getCachePath,
  type CachedToken,
} from "../src/auth/token-store.js";

describe("token-store", () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skylight-mcp-test-"));
    process.env.SKYLIGHT_CACHE_DIR = tmp;
    // getCachePath reads env at call time in the tests via a module reset hook
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  const sample: CachedToken = {
    refreshToken: "rt-123",
    accessToken: "at-456",
    expiresAt: 1_900_000_000_000,
    seedHash: "abc123",
  };

  it("round-trips save and load", async () => {
    const store = await import("../src/auth/token-store.js");
    store.save(sample);
    expect(store.load()).toEqual(sample);
  });

  it("load returns null for missing file", async () => {
    const store = await import("../src/auth/token-store.js");
    expect(store.load()).toBeNull();
  });

  it("load returns null and warns on corrupt JSON", async () => {
    const store = await import("../src/auth/token-store.js");
    const path = store.getCachePath();
    writeFileSync(path, "{not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.load()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("load returns null on schema drift (missing fields)", async () => {
    const store = await import("../src/auth/token-store.js");
    const path = store.getCachePath();
    writeFileSync(path, JSON.stringify({ refreshToken: "x" }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(store.load()).toBeNull();
    warn.mockRestore();
  });

  it("clear removes the file and is idempotent", async () => {
    const store = await import("../src/auth/token-store.js");
    store.save(sample);
    store.clear();
    expect(store.load()).toBeNull();
    expect(() => store.clear()).not.toThrow();
  });

  it("hashSeed is deterministic and differs per input", async () => {
    const store = await import("../src/auth/token-store.js");
    expect(store.hashSeed("same")).toBe(store.hashSeed("same"));
    expect(store.hashSeed("a")).not.toBe(store.hashSeed("b"));
    expect(store.hashSeed("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honors SKYLIGHT_CACHE_DIR override", async () => {
    const store = await import("../src/auth/token-store.js");
    expect(store.getCachePath()).toBe(join(tmp, "token.json"));
  });

  it.runIf(process.platform !== "win32")("saved file has mode 0o600 on POSIX", async () => {
    const store = await import("../src/auth/token-store.js");
    store.save(sample);
    const mode = statSync(store.getCachePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- token-store`
Expected: FAIL — "Cannot find module '../src/auth/token-store.js'"

- [ ] **Step 3: Create `src/auth/token-store.ts`**

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedToken {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  seedHash: string;
}

export function getCachePath(): string {
  const override = process.env.SKYLIGHT_CACHE_DIR;
  if (override) {
    return join(override, "token.json");
  }
  const platform = process.platform;
  if (platform === "win32") {
    const base = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(base, "skylight-mcp", "token.json");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "skylight-mcp", "token.json");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "skylight-mcp", "token.json");
}

function isValidCachedToken(value: unknown): value is CachedToken {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.refreshToken === "string" &&
    typeof v.accessToken === "string" &&
    typeof v.expiresAt === "number" &&
    typeof v.seedHash === "string"
  );
}

export function load(): CachedToken | null {
  const path = getCachePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(`[auth] cache file at ${path} is corrupt; ignoring`);
    return null;
  }
  if (!isValidCachedToken(parsed)) {
    console.error(`[auth] cache file at ${path} has unexpected shape; ignoring`);
    return null;
  }
  return parsed;
}

export function save(token: CachedToken): void {
  const path = getCachePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function clear(): void {
  const path = getCachePath();
  try {
    unlinkSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

export function hashSeed(envToken: string): string {
  return createHash("sha256").update(envToken).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- token-store`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-store.ts tests/token-store.test.ts
git commit -m "feat(auth): add TokenStore for persisted OAuth cache"
```

---

## Task 4: Rewrite `src/api/auth.ts` — `refreshAccessToken()`

**Files:**
- Create: `tests/auth.test.ts`
- Modify (full replace): `src/api/auth.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { refreshAccessToken } from "../src/api/auth.js";

describe("refreshAccessToken", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T12:00:00Z"));
  });

  afterEach(() => {
    global.fetch = origFetch;
    vi.useRealTimers();
  });

  it("POSTs refresh_token grant and returns rotated fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 7200,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken({
      clientId: "client-1",
      refreshToken: "old-refresh",
      fingerprint: "fp-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.ourskylight.com/oauth/token");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: "refresh_token",
      client_id: "client-1",
      refresh_token: "old-refresh",
      fingerprint: "fp-1",
    });

    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.expiresAt).toBe(Date.parse("2026-04-15T12:00:00Z") + 7200 * 1000);
  });

  it("throws TokenRefreshError invalid_grant on 400 with error body", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "revoked" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    ) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({
      name: "TokenRefreshError",
      refreshErrorCode: "invalid_grant",
    });
  });

  it("throws TokenRefreshError network on fetch rejection", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({
      name: "TokenRefreshError",
      refreshErrorCode: "network",
    });
  });

  it("throws TokenRefreshError network on non-400 5xx", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response("upstream down", { status: 502 })
    ) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({ refreshErrorCode: "network" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth`
Expected: FAIL — `refreshAccessToken` does not exist on `src/api/auth.ts` (the existing file exports `login`, `getAuth`, `clearAuthCache`).

- [ ] **Step 3: Replace `src/api/auth.ts` entirely**

```ts
/**
 * Skylight OAuth2 authentication.
 *
 * Skylight's Doorkeeper is configured to rotate refresh tokens on every use.
 * Rotation IS enforced. Callers MUST persist `refreshToken` from the response
 * and use it on the next refresh. Empirically verified 2026-04-15.
 */
import { TokenRefreshError } from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

export interface RefreshParams {
  clientId: string;
  refreshToken: string;
  fingerprint: string;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

export async function refreshAccessToken(params: RefreshParams): Promise<RefreshResult> {
  const { clientId, refreshToken, fingerprint } = params;
  const body = {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    fingerprint,
  };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new TokenRefreshError({ code: "network", cause });
  }

  if (response.status === 400 || response.status === 401) {
    let parsed: OAuthErrorResponse | null = null;
    try {
      parsed = (await response.json()) as OAuthErrorResponse;
    } catch {
      // fall through to generic network error
    }
    if (parsed?.error === "invalid_grant") {
      throw new TokenRefreshError({ code: "invalid_grant" });
    }
    throw new TokenRefreshError({
      code: "network",
      cause: new Error(`HTTP ${response.status}: ${parsed?.error ?? "unknown"}`),
    });
  }

  if (!response.ok) {
    throw new TokenRefreshError({
      code: "network",
      cause: new Error(`HTTP ${response.status}`),
    });
  }

  const data = (await response.json()) as OAuthTokenResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
```

Note: this fully deletes `login()`, `getAuth()`, `clearAuthCache()`, `LoginResponse`, `AuthResult`. The tree is still red (client.ts imports them) — that gets fixed in Task 7.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- auth`
Expected: PASS — all 4 `refreshAccessToken` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/api/auth.ts tests/auth.test.ts
git commit -m "feat(auth): add refreshAccessToken for OAuth token rotation"
```

Tree typecheck is still red until Task 7. That's expected per the spec's commit-order guidance — we land the auth primitives first, then wire the client.

---

## Task 5: Create `TokenManager` — tests first

**Files:**
- Create: `tests/token-manager.test.ts`
- Create: `src/auth/token-manager.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/token-manager.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TokenRefreshError } from "../src/utils/errors.js";

vi.mock("../src/api/auth.js", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("../src/auth/token-store.js", () => {
  let stored: unknown = null;
  return {
    load: vi.fn(() => stored),
    save: vi.fn((token: unknown) => {
      stored = token;
    }),
    clear: vi.fn(() => {
      stored = null;
    }),
    hashSeed: vi.fn((s: string) => `hash(${s})`),
    __setStored: (t: unknown) => {
      stored = t;
    },
    __getStored: () => stored,
  };
});

import { refreshAccessToken } from "../src/api/auth.js";
import * as tokenStore from "../src/auth/token-store.js";
import { TokenManager } from "../src/auth/token-manager.js";

const refresh = refreshAccessToken as unknown as ReturnType<typeof vi.fn>;
const store = tokenStore as unknown as {
  load: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  hashSeed: ReturnType<typeof vi.fn>;
  __setStored: (t: unknown) => void;
  __getStored: () => unknown;
};

const config = {
  clientId: "client-1",
  envRefreshToken: "env-seed",
  fingerprint: "fp-1",
};

const FUTURE = Date.now() + 3_600_000;
const PAST = Date.now() - 1000;

function makeManager() {
  return new TokenManager(config);
}

beforeEach(() => {
  vi.clearAllMocks();
  store.__setStored(null);
});

describe("TokenManager.getAccessToken", () => {
  it("cold start uses env token and persists the response", async () => {
    refresh.mockResolvedValue({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    const token = await tm.getAccessToken();

    expect(token).toBe("at-1");
    expect(refresh).toHaveBeenCalledWith({
      clientId: "client-1",
      refreshToken: "env-seed",
      fingerprint: "fp-1",
    });
    expect(store.save).toHaveBeenCalledWith({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: FUTURE,
      seedHash: "hash(env-seed)",
    });
  });

  it("warm start with valid cached access token makes no network call", async () => {
    store.__setStored({
      accessToken: "cached-at",
      refreshToken: "cached-rt",
      expiresAt: FUTURE,
      seedHash: "hash(env-seed)",
    });

    const tm = makeManager();
    const token = await tm.getAccessToken();

    expect(token).toBe("cached-at");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("warm start with expired access token refreshes using cached refresh token", async () => {
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: PAST,
      seedHash: "hash(env-seed)",
    });
    refresh.mockResolvedValue({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    const token = await tm.getAccessToken();

    expect(token).toBe("at-2");
    expect(refresh).toHaveBeenCalledWith({
      clientId: "client-1",
      refreshToken: "cached-rt",
      fingerprint: "fp-1",
    });
  });

  it("refreshes when cached token expires within 5 minutes", async () => {
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: Date.now() + 4 * 60 * 1000,
      seedHash: "hash(env-seed)",
    });
    refresh.mockResolvedValue({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    await tm.getAccessToken();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("env var rotation clears cache and re-seeds from env", async () => {
    store.__setStored({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: FUTURE,
      seedHash: "hash(old-seed)",
    });
    refresh.mockResolvedValue({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    const token = await tm.getAccessToken();

    expect(store.clear).toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "env-seed" })
    );
    expect(token).toBe("at-new");
  });

  it("dedupes concurrent refreshes", async () => {
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: PAST,
      seedHash: "hash(env-seed)",
    });
    let resolveRefresh: (v: unknown) => void = () => {};
    refresh.mockImplementation(
      () =>
        new Promise((r) => {
          resolveRefresh = r;
        })
    );

    const tm = makeManager();
    const p1 = tm.getAccessToken();
    const p2 = tm.getAccessToken();
    resolveRefresh({
      accessToken: "at-3",
      refreshToken: "rt-3",
      expiresAt: FUTURE,
    });

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe("at-3");
    expect(t2).toBe("at-3");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("persists the rotated refresh_token from the response (regression)", async () => {
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: PAST,
      seedHash: "hash(env-seed)",
    });
    refresh.mockResolvedValue({
      accessToken: "at-4",
      refreshToken: "rotated-rt",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    await tm.getAccessToken();

    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rotated-rt" })
    );
  });

  it("invalid_grant with cached token attempts env fallback", async () => {
    // Cached token differs from env; first refresh fails, env fallback succeeds.
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: PAST,
      seedHash: "hash(env-seed)",
    });
    refresh
      .mockRejectedValueOnce(new TokenRefreshError({ code: "invalid_grant" }))
      .mockResolvedValueOnce({
        accessToken: "at-fb",
        refreshToken: "rt-fb",
        expiresAt: FUTURE,
      });

    const tm = makeManager();
    const token = await tm.getAccessToken();

    expect(token).toBe("at-fb");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[1][0]).toMatchObject({ refreshToken: "env-seed" });
  });

  it("invalid_grant with no useful fallback throws stage=seed", async () => {
    refresh.mockRejectedValue(new TokenRefreshError({ code: "invalid_grant" }));
    const tm = makeManager();
    await expect(tm.getAccessToken()).rejects.toMatchObject({
      refreshErrorCode: "invalid_grant",
      stage: "seed",
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("invalid_grant on cached refresh AND env fallback throws stage=cached", async () => {
    store.__setStored({
      accessToken: "old-at",
      refreshToken: "cached-rt",
      expiresAt: PAST,
      seedHash: "hash(env-seed)",
    });
    refresh.mockRejectedValue(new TokenRefreshError({ code: "invalid_grant" }));

    const tm = makeManager();
    await expect(tm.getAccessToken()).rejects.toMatchObject({
      refreshErrorCode: "invalid_grant",
      stage: "cached",
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("network error propagates without save", async () => {
    refresh.mockRejectedValue(new TokenRefreshError({ code: "network" }));
    const tm = makeManager();
    await expect(tm.getAccessToken()).rejects.toMatchObject({
      refreshErrorCode: "network",
    });
    expect(store.save).not.toHaveBeenCalled();
  });
});

describe("TokenManager.forceRefresh", () => {
  it("ignores 5-minute expiry headroom and always refreshes", async () => {
    store.__setStored({
      accessToken: "cached-at",
      refreshToken: "cached-rt",
      expiresAt: FUTURE,
      seedHash: "hash(env-seed)",
    });
    refresh.mockResolvedValue({
      accessToken: "at-force",
      refreshToken: "rt-force",
      expiresAt: FUTURE,
    });

    const tm = makeManager();
    // First load cached state via getAccessToken (no refresh).
    await tm.getAccessToken();
    expect(refresh).not.toHaveBeenCalled();

    const forced = await tm.forceRefresh();
    expect(forced).toBe("at-force");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- token-manager`
Expected: FAIL — "Cannot find module '../src/auth/token-manager.js'"

- [ ] **Step 3: Create `src/auth/token-manager.ts`**

```ts
import { refreshAccessToken, type RefreshResult } from "../api/auth.js";
import * as TokenStore from "./token-store.js";
import type { CachedToken } from "./token-store.js";
import { TokenRefreshError } from "../utils/errors.js";

const EXPIRY_HEADROOM_MS = 5 * 60 * 1000;

export interface TokenManagerConfig {
  clientId: string;
  envRefreshToken: string;
  fingerprint: string;
}

export class TokenManager {
  private cached: CachedToken | null = null;
  private loaded = false;
  private refreshInFlight: Promise<CachedToken> | null = null;

  constructor(private readonly config: TokenManagerConfig) {}

  async getAccessToken(): Promise<string> {
    this.ensureLoaded();

    const envHash = TokenStore.hashSeed(this.config.envRefreshToken);
    if (this.cached && this.cached.seedHash !== envHash) {
      console.error("[auth] cache seed mismatch; re-seeding from env");
      TokenStore.clear();
      this.cached = null;
    }

    if (this.cached && this.cached.expiresAt - Date.now() > EXPIRY_HEADROOM_MS) {
      const secs = Math.round((this.cached.expiresAt - Date.now()) / 1000);
      console.error(`[auth] cache hit; access token valid for ${secs}s`);
      return this.cached.accessToken;
    }

    const refreshed = await this.doRefresh();
    return refreshed.accessToken;
  }

  async forceRefresh(): Promise<string> {
    this.ensureLoaded();
    const refreshed = await this.doRefresh();
    return refreshed.accessToken;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.cached = TokenStore.load();
    this.loaded = true;
  }

  private async doRefresh(): Promise<CachedToken> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.doRefreshInner().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async doRefreshInner(): Promise<CachedToken> {
    const primaryToken = this.cached?.refreshToken ?? this.config.envRefreshToken;
    const usedCached = this.cached !== null && primaryToken !== this.config.envRefreshToken;

    console.error("[auth] refreshing access token");
    let result: RefreshResult;
    try {
      result = await refreshAccessToken({
        clientId: this.config.clientId,
        refreshToken: primaryToken,
        fingerprint: this.config.fingerprint,
      });
    } catch (err) {
      if (
        err instanceof TokenRefreshError &&
        err.refreshErrorCode === "invalid_grant" &&
        usedCached
      ) {
        // Fallback: try the env seed once.
        try {
          result = await refreshAccessToken({
            clientId: this.config.clientId,
            refreshToken: this.config.envRefreshToken,
            fingerprint: this.config.fingerprint,
          });
        } catch (fallbackErr) {
          const code =
            fallbackErr instanceof TokenRefreshError
              ? fallbackErr.refreshErrorCode
              : "network";
          console.error(`[auth] refresh failed: ${code}`);
          if (fallbackErr instanceof TokenRefreshError && code === "invalid_grant") {
            throw new TokenRefreshError({ code: "invalid_grant", stage: "cached" });
          }
          throw fallbackErr;
        }
      } else {
        const code =
          err instanceof TokenRefreshError ? err.refreshErrorCode : "network";
        console.error(`[auth] refresh failed: ${code}`);
        if (err instanceof TokenRefreshError && code === "invalid_grant") {
          throw new TokenRefreshError({ code: "invalid_grant", stage: "seed" });
        }
        throw err;
      }
    }

    const token: CachedToken = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: result.expiresAt,
      seedHash: TokenStore.hashSeed(this.config.envRefreshToken),
    };
    TokenStore.save(token);
    this.cached = token;
    const secs = Math.round((result.expiresAt - Date.now()) / 1000);
    console.error(`[auth] refresh ok; expires in ${secs}s`);
    return token;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- token-manager`
Expected: PASS — all 12 TokenManager tests green.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-manager.ts tests/token-manager.test.ts
git commit -m "feat(auth): add TokenManager for refresh-token orchestration"
```

---

## Task 6: Wire `SkylightClient` to `TokenManager`

**Files:**
- Create: `tests/client.test.ts`
- Modify: `src/api/client.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/client.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const getAccessToken = vi.fn();
const forceRefresh = vi.fn();

vi.mock("../src/auth/token-manager.js", () => ({
  TokenManager: vi.fn().mockImplementation(() => ({
    getAccessToken,
    forceRefresh,
  })),
}));

import { SkylightClient } from "../src/api/client.js";
import type { Config } from "../src/config.js";

const baseConfig: Config = {
  clientId: "c",
  refreshToken: "r",
  fingerprint: "f",
  frameId: "frame-1",
  timezone: "America/New_York",
};

describe("SkylightClient", () => {
  const origFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    getAccessToken.mockResolvedValue("access-token");
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = origFetch;
  });

  it("sends Bearer access token on requests", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const client = new SkylightClient(baseConfig);
    await client.get("/api/frames/{frameId}/chores");

    const init = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer access-token");
  });

  it("retries once on 401 with forceRefresh, then succeeds", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );

    const client = new SkylightClient(baseConfig);
    const result = await client.get<{ ok: boolean }>("/api/frames/{frameId}/chores");

    expect(result).toEqual({ ok: true });
    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates after two consecutive 401s (no infinite loop)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));

    const client = new SkylightClient(baseConfig);
    await expect(client.get("/api/frames/{frameId}/chores")).rejects.toThrow();
    expect(forceRefresh).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("initialize calls getAccessToken then loads subscription status", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            attributes: { subscription_status: "plus" },
          },
        }),
        { status: 200 }
      )
    );

    const client = new SkylightClient(baseConfig);
    await client.initialize();

    expect(getAccessToken).toHaveBeenCalled();
    expect(client.hasPlus()).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- client`
Expected: FAIL — compilation errors from the old `client.ts` referencing dead config fields (email, password, token, authType).

- [ ] **Step 3: Replace `src/api/client.ts` entirely**

```ts
import { getConfig, type Config } from "../config.js";
import { TokenManager } from "../auth/token-manager.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
}

interface UserResponse {
  data?: {
    attributes?: {
      subscription_status?: string;
    };
  };
}

export class SkylightClient {
  private config: Config;
  private tokenManager: TokenManager;
  private subscriptionStatus: SubscriptionStatus = null;

  constructor(config?: Config) {
    this.config = config ?? getConfig();
    this.tokenManager = new TokenManager({
      clientId: this.config.clientId,
      envRefreshToken: this.config.refreshToken,
      fingerprint: this.config.fingerprint,
    });
  }

  private async getAuthHeader(): Promise<string> {
    const token = await this.tokenManager.getAccessToken();
    return `Bearer ${token}`;
  }

  private buildUrl(
    endpoint: string,
    params?: Record<string, string | boolean | number | undefined>
  ): string {
    const url = new URL(endpoint, BASE_URL);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      console.error(`[client] 401 Unauthorized for ${url}`);
      throw new AuthenticationError();
    }
    if (status === 404) {
      throw new NotFoundError("Resource");
    }
    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // ignore
    }
    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  async request<T>(
    endpoint: string,
    options: RequestOptions = {},
    isRetry = false
  ): Promise<T> {
    const { method = "GET", params, body } = options;
    const resolvedEndpoint = endpoint.replace("{frameId}", this.config.frameId);
    const url = this.buildUrl(resolvedEndpoint, params);

    console.error(`[client] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(),
      Accept: "application/json",
    };
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      if (response.status === 401 && !isRetry) {
        console.error("[client] Got 401, forcing token refresh and retrying...");
        await this.tokenManager.forceRefresh();
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    if (response.status === 304) {
      return {} as T;
    }
    return response.json() as Promise<T>;
  }

  async get<T>(
    endpoint: string,
    params?: Record<string, string | boolean | number | undefined>
  ): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  get frameId(): string {
    return this.config.frameId;
  }

  get timezone(): string {
    return this.config.timezone;
  }

  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  private async loadSubscriptionStatus(): Promise<void> {
    try {
      const user = await this.get<UserResponse>("/api/user");
      const status = user.data?.attributes?.subscription_status;
      if (status === "plus" || status === "free" || status === "trial") {
        this.subscriptionStatus = status;
      }
    } catch (err) {
      console.error(
        `[client] failed to load subscription status: ${(err as Error).message}`
      );
    }
  }

  async initialize(): Promise<void> {
    await this.tokenManager.getAccessToken();
    await this.loadSubscriptionStatus();
  }
}

let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  if (!clientInstance) {
    clientInstance = new SkylightClient();
  }
  return clientInstance;
}

export async function initializeClient(): Promise<SkylightClient> {
  const client = getClient();
  await client.initialize();
  return client;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- client`
Expected: PASS — all 4 client tests green.

- [ ] **Step 5: Run full test suite + typecheck to verify the tree is green**

Run: `npm test && npm run typecheck && npm run lint`
Expected: ALL PASS. If any tool file imports `usesEmailAuth` or `login` from the old modules, fix the import and re-run. At this point the whole tree should compile and test green.

- [ ] **Step 6: Commit**

```bash
git add src/api/client.ts src/config.ts .env.example tests/client.test.ts
git commit -m "feat(client): delegate auth to TokenManager, drop legacy login"
```

Note: `src/config.ts` and `.env.example` were edited back in Task 2 but never committed. They ride along in this commit because it's the first one where the tree actually compiles.

---

## Task 7: Audit tool modules for dead imports

**Files:**
- Check: `src/tools/*.ts`, `src/server.ts`, `src/index.ts`

The rewrites in Task 6 renamed or deleted several exports. This task is a sweep to find any stale references.

- [ ] **Step 1: Search for references to deleted symbols**

Run: `npm run typecheck`
Also manually check:

```
grep -r "usesEmailAuth\|getCredentials\|clearAuthCache\|getAuth\|SKYLIGHT_AUTH_TYPE\|SKYLIGHT_EMAIL\|SKYLIGHT_PASSWORD\|SKYLIGHT_TOKEN[^_]" src/ tests/ README.md 2>/dev/null
```

Expected: only matches should be in `.env.example` comments (none — we rewrote that file), README.md (we'll fix in Task 8), or in CHANGELOG history. If any match shows up in `src/` or `tests/`, it must be removed.

- [ ] **Step 2: Fix any stale references**

For each match in `src/`:
- If it's an import, delete the import and the usage.
- If it's documentation/comment, delete the line.

Do NOT add fallbacks or compat shims — the old auth path is dead code.

- [ ] **Step 3: Verify green**

Run: `npm test && npm run typecheck && npm run lint`
Expected: ALL PASS.

- [ ] **Step 4: Commit (only if step 2 made changes)**

```bash
git add -u
git commit -m "chore: remove stale references to legacy email/password auth"
```

If Step 2 found nothing, skip this commit.

---

## Task 8: Update README with OAuth + cache documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the Authentication section of README**

Find the "Authentication" (or equivalent) section. Replace any email/password instructions with:

```markdown
## Authentication

Skylight migrated to OAuth2 (Doorkeeper) in early 2026. The legacy `POST /api/sessions` endpoint no longer works. To use this MCP server, you must capture OAuth credentials from the Skylight mobile app using a TLS proxy.

### Capturing credentials

1. Install a TLS proxy (mitmproxy, Charles, Proxyman) and configure your phone to trust its CA.
2. Open the Skylight mobile app and log in.
3. Find the `POST https://app.ourskylight.com/oauth/token` request.
4. From the request body, copy:
   - `client_id` → `SKYLIGHT_CLIENT_ID`
   - `refresh_token` → `SKYLIGHT_REFRESH_TOKEN`
   - `fingerprint` → `SKYLIGHT_FINGERPRINT`
5. Find your frame ID in a request URL like `/api/frames/{frameId}/chores` → `SKYLIGHT_FRAME_ID`.

### Token persistence

On first use, the MCP exchanges your refresh token for an access token and caches the result to a local file. Skylight rotates refresh tokens on every refresh, so the cache file is rewritten after each exchange. Location:

- Windows: `%APPDATA%\skylight-mcp\token.json`
- macOS: `~/Library/Application Support/skylight-mcp/token.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/skylight-mcp/token.json`

Override with `SKYLIGHT_CACHE_DIR`.

### Recovery

If you see "refresh token is invalid or revoked" in the logs, re-capture `SKYLIGHT_REFRESH_TOKEN` from the mobile app, update `claude_desktop_config.json`, and restart Claude Desktop. The old cache file is cleared automatically on the next run (via a seed-hash check).

**Known limitation:** Running two MCP processes concurrently will burn the refresh token (the second process sees `invalid_grant`). This is not supported.
```

- [ ] **Step 2: Update any "Configuration" / env-var tables in README**

Replace rows for `SKYLIGHT_EMAIL`, `SKYLIGHT_PASSWORD`, `SKYLIGHT_TOKEN`, `SKYLIGHT_AUTH_TYPE` with:

| Variable | Required | Description |
|---|---|---|
| `SKYLIGHT_CLIENT_ID` | yes | OAuth client ID, captured from mobile app |
| `SKYLIGHT_REFRESH_TOKEN` | yes | OAuth refresh token, captured from mobile app |
| `SKYLIGHT_FINGERPRINT` | yes | Device fingerprint, captured from mobile app |
| `SKYLIGHT_FRAME_ID` | yes | Household/frame ID |
| `SKYLIGHT_CACHE_DIR` | no | Override for token cache directory |
| `SKYLIGHT_TIMEZONE` | no | Default `America/New_York` |

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for OAuth auth and token cache"
```

---

## Task 9: Acceptance verification

**Files:** none (verification only)

- [ ] **Step 1: Full verification sweep**

Run all three in sequence:

```bash
npm run lint
npm run typecheck
npm test
```

Expected: all green. No warnings about unused imports. Coverage should include the new test files.

- [ ] **Step 2: Cold-start dry run**

Ensure `.env` (or equivalent) has real `SKYLIGHT_CLIENT_ID`, `SKYLIGHT_REFRESH_TOKEN`, `SKYLIGHT_FINGERPRINT`, `SKYLIGHT_FRAME_ID`.

Delete any existing cache file:

```bash
# macOS/Linux
rm -f "${SKYLIGHT_CACHE_DIR:-$HOME/.config}/skylight-mcp/token.json" 2>/dev/null || true
```

```powershell
# Windows
Remove-Item -ErrorAction SilentlyContinue "$env:APPDATA\skylight-mcp\token.json"
```

Run the spot-check script:

```bash
node scripts/spot-check.mjs
```

Expected:
- stderr logs show `[auth] refreshing access token` then `[auth] refresh ok; expires in ~7200s`.
- All base tools pass (chores, lists, calendar, family).
- Plus tools pass if the account has Plus.
- A cache file appears at the expected path containing a `refreshToken`, `accessToken`, `expiresAt`, `seedHash`.

- [ ] **Step 3: Warm-start dry run**

Run the spot-check again immediately:

```bash
node scripts/spot-check.mjs
```

Expected:
- stderr shows `[auth] cache hit; access token valid for Xs` (no refresh).
- `scripts/spot-check.mjs` passes identically.

- [ ] **Step 4: Env-var rotation dry run**

Edit the `.env` (or Claude Desktop config) to a deliberately wrong `SKYLIGHT_REFRESH_TOKEN` (e.g., trailing `x`). Run spot-check. Expected: one refresh attempt, `invalid_grant`, `TokenRefreshError` with stage=seed, user-facing message contains "re-capture a refresh token." The cache file is left in place (seed-hash mismatch will clean it up on the next valid run).

Restore the real `SKYLIGHT_REFRESH_TOKEN`. Run spot-check. Expected: cache is cleared via seedHash mismatch, fresh refresh succeeds, new cache written. Spot-check passes.

- [ ] **Step 5: No-op if all steps 1–4 passed**

This task produces no commit. If any step fails, file the failure, debug, and fix — do NOT paper over with retries or backoff.

---

## Acceptance criteria (from spec)

Cross-reference with spec §"Acceptance criteria":

1. ✅ Cold start with valid env refresh token → Task 9 Step 2
2. ✅ Warm restart within 2 hours → Task 9 Step 3
3. ✅ Warm restart after 2 hours → covered by unit test "refreshes when cached token expires within 5 minutes" (Task 5)
4. ✅ User rotates `SKYLIGHT_REFRESH_TOKEN` → Task 9 Step 4
5. ✅ User deletes cache file → covered by unit test "cold start, no cache → uses env token" (Task 5) and `load` returns null on ENOENT (Task 3)
6. ✅ Two concurrent MCP processes burn the refresh token → documented in README (Task 8). Not auto-recovered; matches spec §Non-goals.
7. ✅ Existing unit tests (`dates`, `errors`) continue to pass → Task 9 Step 1
8. ✅ New unit tests pass → Tasks 3, 4, 5, 6
9. ✅ `npm run lint` and `npm run typecheck` clean → Task 9 Step 1
