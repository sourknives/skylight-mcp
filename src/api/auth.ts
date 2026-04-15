/**
 * Skylight Authentication (OAuth refresh-token flow)
 *
 * Skylight migrated from /api/sessions email/password login to a Doorkeeper
 * OAuth flow in early 2026. The legacy login endpoint now always returns
 * "This version of Skylight is no longer supported."
 *
 * The supported flow is:
 *   POST /oauth/token
 *     {
 *       grant_type: "refresh_token",
 *       refresh_token: "<refresh token>",
 *       client_id:    "<public client id from web bundle>",
 *       fingerprint:  "<device UUID, stable per install>"
 *     }
 *   -> { access_token, token_type: "Bearer", expires_in: 7200,
 *        refresh_token: <rotated token, can be ignored>, scope, created_at }
 *
 * Skylight's Doorkeeper is NOT configured to invalidate refresh tokens on
 * use (verified empirically), so the original refresh token stays valid
 * across refreshes. We simply re-use the configured refresh token on every
 * refresh and ignore the rotated value returned in the response.
 */

const BASE_URL = "https://app.ourskylight.com";

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  created_at: number;
}

export interface AuthResult {
  accessToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface RefreshOptions {
  clientId: string;
  refreshToken: string;
  fingerprint: string;
}

/**
 * Exchange a refresh token for a new access token.
 */
export async function refreshAccessToken(opts: RefreshOptions): Promise<AuthResult> {
  console.error("[auth] Refreshing OAuth access token...");

  const response = await fetch(`${BASE_URL}/oauth/token`, {
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

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      // ignore
    }
    const snippet = errorBody ? ` - ${errorBody.slice(0, 500)}` : "";
    throw new Error(
      `OAuth refresh failed (HTTP ${response.status})${snippet}. ` +
        `If the refresh token is invalid/revoked, re-bootstrap credentials ` +
        `from the Skylight web app (see README).`
    );
  }

  const data = (await response.json()) as OAuthTokenResponse;
  console.error(`[auth] Refresh OK; access token expires in ${data.expires_in}s`);

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
