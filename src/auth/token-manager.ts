/**
 * Stateful orchestrator for the OAuth refresh-token lifecycle.
 *
 * Responsibilities:
 *  - Lazy-load the persisted cache on first use.
 *  - Detect env-var rotation (user edited SKYLIGHT_REFRESH_TOKEN) and
 *    discard the stale cache.
 *  - Return the cached access token when it's still valid (with a
 *    5-minute expiry headroom).
 *  - Refresh via the OAuth endpoint and persist the rotated tokens.
 *  - Deduplicate concurrent refreshes so a burst of simultaneous API
 *    calls only ever triggers one /oauth/token round trip.
 *  - Attempt a one-shot fallback to the env seed if the cached refresh
 *    token is rejected (handles stale cache scenarios).
 *  - Tag invalid_grant failures with stage=seed vs stage=cached so the
 *    user-facing message can explain whether re-capturing the env var
 *    is likely to help.
 */
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

  /**
   * Return a valid access token, refreshing if necessary. The hot path
   * (cached token still fresh) makes no network call.
   */
  async getAccessToken(): Promise<string> {
    this.ensureLoaded();
    this.discardCacheIfSeedChanged();

    if (
      this.cached &&
      this.cached.expiresAt - Date.now() > EXPIRY_HEADROOM_MS
    ) {
      const secs = Math.round((this.cached.expiresAt - Date.now()) / 1000);
      console.error(`[auth] cache hit; access token valid for ${secs}s`);
      return this.cached.accessToken;
    }

    const refreshed = await this.doRefresh();
    return refreshed.accessToken;
  }

  /**
   * Force an unconditional refresh, ignoring the expiry headroom. Used
   * by SkylightClient after a mid-session 401.
   */
  async forceRefresh(): Promise<string> {
    this.ensureLoaded();
    this.discardCacheIfSeedChanged();
    const refreshed = await this.doRefresh();
    return refreshed.accessToken;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.cached = TokenStore.load();
    this.loaded = true;
  }

  private discardCacheIfSeedChanged(): void {
    if (!this.cached) return;
    const envHash = TokenStore.hashSeed(this.config.envRefreshToken);
    if (this.cached.seedHash !== envHash) {
      console.error("[auth] cache seed mismatch; re-seeding from env");
      TokenStore.clear();
      this.cached = null;
    }
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
    const primaryIsCached =
      this.cached !== null && primaryToken !== this.config.envRefreshToken;

    console.error("[auth] refreshing access token");

    let result: RefreshResult;
    try {
      result = await this.callRefresh(primaryToken);
    } catch (err) {
      if (
        err instanceof TokenRefreshError &&
        err.refreshErrorCode === "invalid_grant" &&
        primaryIsCached
      ) {
        // Cached refresh token rejected. Try the env seed once before
        // giving up — handles the case where the cache got stale but
        // the env var is still good.
        try {
          result = await this.callRefresh(this.config.envRefreshToken);
        } catch (fallbackErr) {
          if (
            fallbackErr instanceof TokenRefreshError &&
            fallbackErr.refreshErrorCode === "invalid_grant"
          ) {
            console.error("[auth] refresh failed: invalid_grant");
            throw new TokenRefreshError({ code: "invalid_grant", stage: "cached" });
          }
          throw fallbackErr;
        }
      } else if (
        err instanceof TokenRefreshError &&
        err.refreshErrorCode === "invalid_grant"
      ) {
        console.error("[auth] refresh failed: invalid_grant");
        throw new TokenRefreshError({ code: "invalid_grant", stage: "seed" });
      } else {
        const code =
          err instanceof TokenRefreshError ? err.refreshErrorCode : "network";
        console.error(`[auth] refresh failed: ${code}`);
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

  private callRefresh(refreshToken: string): Promise<RefreshResult> {
    return refreshAccessToken({
      clientId: this.config.clientId,
      refreshToken,
      fingerprint: this.config.fingerprint,
    });
  }
}
