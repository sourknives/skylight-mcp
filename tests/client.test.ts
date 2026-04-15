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

  it("substitutes {frameId} placeholder in the URL", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const client = new SkylightClient(baseConfig);
    await client.get("/api/frames/{frameId}/chores");

    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(url).toBe("https://app.ourskylight.com/api/frames/frame-1/chores");
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
            id: "user-1",
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
    expect(client.getSubscriptionStatus()).toBe("plus");
  });

  it("initialize tolerates /api/user failure (subscription stays null)", async () => {
    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(new Response("server error", { status: 500 }));

    const client = new SkylightClient(baseConfig);
    await client.initialize();

    expect(getAccessToken).toHaveBeenCalled();
    expect(client.hasPlus()).toBe(false);
    expect(client.getSubscriptionStatus()).toBeNull();
  });
});
