import { z } from "zod";

// Skylight migrated to OAuth in early 2026. The legacy /api/sessions endpoint
// now returns "This version of Skylight is no longer supported." for all
// requests, so email/password login is no longer supported by this server.
//
// Auth is OAuth refresh-token flow. Bootstrap by capturing tokens from the
// official web app at https://app.ourskylight.com once; the refresh token
// is a long-lived credential that is NOT invalidated when used (verified
// empirically), so we just re-use it on every refresh and never persist
// the rotated value.
const ConfigSchema = z.object({
  clientId: z.string().min(1, "SKYLIGHT_CLIENT_ID is required"),
  refreshToken: z.string().min(1, "SKYLIGHT_REFRESH_TOKEN is required"),
  fingerprint: z.string().min(1, "SKYLIGHT_FINGERPRINT is required"),
  frameId: z.string().min(1, "SKYLIGHT_FRAME_ID is required"),
  timezone: z.string().default("America/New_York"),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const result = ConfigSchema.safeParse({
    clientId: process.env.SKYLIGHT_CLIENT_ID,
    refreshToken: process.env.SKYLIGHT_REFRESH_TOKEN,
    fingerprint: process.env.SKYLIGHT_FINGERPRINT,
    frameId: process.env.SKYLIGHT_FRAME_ID,
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
      "  SKYLIGHT_TIMEZONE - Timezone for dates (default: America/New_York)\n\n" +
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

// Legacy compatibility shim. Kept so any stale call sites compile.
export function usesEmailAuth(_config: Config): boolean {
  return true;
}
