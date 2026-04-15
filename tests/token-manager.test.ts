import { describe, it, expect, beforeEach, vi } from "vitest";
import { TokenRefreshError } from "../src/utils/errors.js";

vi.mock("../src/api/auth.js", () => ({
  refreshAccessToken: vi.fn(),
}));

vi.mock("../src/auth/token-store.js", () => {
  let stored: unknown = null;
  const fns = {
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
  return fns;
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

  it("invalid_grant on cold start (env seed bad) throws stage=seed", async () => {
    refresh.mockRejectedValue(new TokenRefreshError({ code: "invalid_grant" }));
    const tm = makeManager();
    await expect(tm.getAccessToken()).rejects.toMatchObject({
      refreshErrorCode: "invalid_grant",
      stage: "seed",
    });
    expect(store.save).not.toHaveBeenCalled();
  });

  it("invalid_grant on cached AND env fallback throws stage=cached", async () => {
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
