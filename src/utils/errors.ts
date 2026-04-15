/**
 * Base error class for Skylight API errors
 */
export class SkylightError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = "SkylightError";
  }
}

/**
 * Authentication failed - token may be expired or invalid
 */
export class AuthenticationError extends SkylightError {
  constructor(message: string = "Authentication failed. Your token may be expired or invalid.") {
    super(message, "AUTH_FAILED", 401, true);
    this.name = "AuthenticationError";
  }
}

/**
 * Configuration error - missing or invalid settings
 */
export class ConfigurationError extends SkylightError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", undefined, true);
    this.name = "ConfigurationError";
  }
}

/**
 * Resource not found
 */
export class NotFoundError extends SkylightError {
  constructor(resource: string) {
    super(`${resource} not found`, "NOT_FOUND", 404, false);
    this.name = "NotFoundError";
  }
}

/**
 * Rate limited by the API
 */
export class RateLimitError extends SkylightError {
  constructor(retryAfter?: number) {
    super(
      `Rate limited by Skylight API. ${retryAfter ? `Retry after ${retryAfter}s` : "Please wait and try again."}`,
      "RATE_LIMITED",
      429,
      true
    );
    this.name = "RateLimitError";
  }
}

/**
 * API returned an unexpected response format
 */
export class ParseError extends SkylightError {
  constructor(message: string = "Unexpected API response format") {
    super(message, "PARSE_ERROR", undefined, false);
    this.name = "ParseError";
  }
}

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

/**
 * Format an error for MCP tool response
 * Accepts unknown to handle any value from catch blocks safely
 */
export function formatErrorForMcp(error: unknown): string {
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

  if (error instanceof AuthenticationError) {
    return `Authentication Error: ${error.message}

Your Skylight token may have expired. To fix this:
1. Open the Skylight app on your device
2. Capture fresh API traffic using a proxy tool
3. Update your SKYLIGHT_TOKEN environment variable

See the auth documentation for detailed steps.`;
  }

  if (error instanceof NotFoundError) {
    return `Not Found: ${error.message}

This could mean:
- The requested item doesn't exist
- Your frame ID is incorrect
- The item was deleted from Skylight`;
  }

  if (error instanceof RateLimitError) {
    return `Rate Limited: ${error.message}

The Skylight API is temporarily limiting requests. Please wait a moment and try again.`;
  }

  if (error instanceof ConfigurationError) {
    return `Configuration Error: ${error.message}

Please check your environment variables are set correctly.`;
  }

  if (error instanceof SkylightError) {
    return `Skylight Error: ${error.message}`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}
