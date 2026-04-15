import { z } from "zod";

// Skylight migrated to OAuth in early 2026. The legacy /api/sessions endpoint
// now returns "This version of Skylight is no longer supported." for all
// requests, so email/password login is no longer supported by this server.
//
// Auth is OAuth refresh-token flow with rotation: every call to /oauth/token
// consumes the current refresh_token and returns a rotated one that MUST be
// persisted across process restarts. Bootstrap by capturing the seed token
// from the official web app at https://app.ourskylight.com; subsequent
// rotations are handled transparently by TokenManager + TokenStore.
const ConfigSchema = z.object({
  clientId: z.string().min(1, "SKYLIGHT_CLIENT_ID is required"),
  refreshToken: z.string().min(1, "SKYLIGHT_REFRESH_TOKEN is required"),
  fingerprint: z.string().min(1, "SKYLIGHT_FINGERPRINT is required"),
  frameId: z.string().min(1, "SKYLIGHT_FRAME_ID is required"),
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
    console.error(
      "\nSkylight MCP Server - Configuration Error\n\n" +
      "Missing or invalid configuration:\n" + errors + "\n\n" +
      "Authentication (OAuth):\n" +
      "  SKYLIGHT_CLIENT_ID     - OAuth client ID (from app.ourskylight.com web bundle)\n" +
      "  SKYLIGHT_REFRESH_TOKEN - OAuth refresh token (from web app auth-storage)\n" +
      "  SKYLIGHT_FINGERPRINT   - Device fingerprint UUID (from web app auth-storage)\n" +
      "  SKYLIGHT_FRAME_ID      - Your frame/household ID\n\n" +
      "Optional:\n" +
      "  SKYLIGHT_CACHE_DIR - Directory for persisted token cache\n" +
      "                      (default: platform-specific user config dir)\n" +
      "  SKYLIGHT_TIMEZONE  - Timezone for dates (default: America/New_York)\n\n" +
      "See README for credential bootstrap instructions.\n"
    );
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
