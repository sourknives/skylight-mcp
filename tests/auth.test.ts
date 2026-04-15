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
      refresh_token: "old-refresh",
      client_id: "client-1",
      fingerprint: "fp-1",
    });

    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
    expect(result.expiresAt).toBe(Date.parse("2026-04-15T12:00:00Z") + 7200 * 1000);
  });

  it("throws TokenRefreshError invalid_grant on 400 with OAuth error body", async () => {
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

  it("throws TokenRefreshError invalid_grant on 401 too", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({ refreshErrorCode: "invalid_grant" });
  });

  it("throws TokenRefreshError network on fetch rejection", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({
      name: "TokenRefreshError",
      refreshErrorCode: "network",
    });
  });

  it("throws TokenRefreshError network on 5xx", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("upstream down", { status: 502 })) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({ refreshErrorCode: "network" });
  });

  it("throws TokenRefreshError network on 400 with non-OAuth body", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("plain text error", { status: 400 })) as unknown as typeof fetch;

    await expect(
      refreshAccessToken({ clientId: "c", refreshToken: "r", fingerprint: "f" })
    ).rejects.toMatchObject({ refreshErrorCode: "network" });
  });
});
