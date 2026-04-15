/**
 * Skylight Authentication (OAuth refresh-token flow)
 *
 * Skylight migrated from /api/sessions email/password login to a Doorkeeper
 * OAuth2 flow in early 2026. The legacy login endpoint now always returns
 * "This version of Skylight is no longer supported."
 *
 * The supported flow is:
 *   POST /oauth/token
 *     {
 *       grant_type:    "refresh_token",
 *       refresh_token: "<refresh token>",
 *       client_id:     "<public client id from web bundle>",
 *       fingerprint:   "<device UUID, stable per install>"
 *     }
 *   -> { access_token, token_type: "Bearer", expires_in: 7200,
 *        refresh_token: <rotated token>, scope, created_at }
 *
 * IMPORTANT: Rotation IS enforced. Every call consumes the current
 * refresh_token; a second call with the same token returns invalid_grant.
 * Callers MUST persist `refreshToken` from the response and use it on the
 * next refresh. Empirically verified 2026-04-15.
 */
import { TokenRefreshError } from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

export interface RefreshOptions {
  clientId: string;
  refreshToken: string;
  fingerprint: string;
}

export interface RefreshResult {
  accessToken: string;
  /** The rotated refresh token from the response; MUST be persisted. */
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
  created_at?: number;
}

interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Exchange a refresh token for a new access token. Always returns the
 * rotated refresh token from the response so the caller can persist it.
 *
 * Throws:
 *  - TokenRefreshError({code:"invalid_grant"}) on 400/401 with invalid_grant
 *  - TokenRefreshError({code:"network", cause}) on any other failure
 */
export async function refreshAccessToken(opts: RefreshOptions): Promise<RefreshResult> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: opts.refreshToken,
        client_id: opts.clientId,
        fingerprint: opts.fingerprint,
      }),
    });
  } catch (cause) {
    throw new TokenRefreshError({ code: "network", cause });
  }

  if (response.status === 400 || response.status === 401) {
    let parsed: OAuthErrorResponse | null = null;
    try {
      parsed = (await response.json()) as OAuthErrorResponse;
    } catch {
      // fall through to generic network error below
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
