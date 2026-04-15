/**
 * Persistent OAuth token cache.
 *
 * Pure file I/O: no HTTP, no OAuth awareness. TokenManager owns the
 * semantics of when to read/write; this module is just the storage layer.
 *
 * The cache file holds the rotated refresh token (because Doorkeeper
 * rotates it on every refresh), plus the current access token and its
 * expiry. A seedHash records the hash of the env-var refresh token at
 * the time of the last save — if the env var changes, the cache is
 * discarded and a fresh seed path is used instead.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedToken {
  refreshToken: string;
  accessToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** sha256 hex of the env refresh token at the time of save. */
  seedHash: string;
}

/**
 * Resolve the cache file path. Honors SKYLIGHT_CACHE_DIR if set; otherwise
 * uses a platform-specific user config directory. Resolved lazily on every
 * call so tests can swap the env var between cases.
 */
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

/**
 * Load the persisted token cache. Returns null if the file is missing,
 * corrupt, or has an unexpected shape. Any other I/O error (permissions,
 * disk) is rethrown.
 */
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

/**
 * Persist the cache atomically via write-and-rename. Sets owner-only file
 * mode (0o600) on POSIX; on Windows the parent directory inherits the
 * user-profile ACL so explicit permission setting is unnecessary.
 */
export function save(token: CachedToken): void {
  const path = getCachePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(token, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Delete the cache file. Idempotent — missing file is not an error. */
export function clear(): void {
  const path = getCachePath();
  try {
    unlinkSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
  }
}

/** Deterministic sha256 of the env-var seed token, used for seed mismatch detection. */
export function hashSeed(envToken: string): string {
  return createHash("sha256").update(envToken).digest("hex");
}
