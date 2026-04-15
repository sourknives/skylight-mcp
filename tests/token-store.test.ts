import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  load,
  save,
  clear,
  hashSeed,
  getCachePath,
  type CachedToken,
} from "../src/auth/token-store.js";

describe("token-store", () => {
  let tmp: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skylight-mcp-test-"));
    process.env.SKYLIGHT_CACHE_DIR = tmp;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  const sample: CachedToken = {
    refreshToken: "rt-123",
    accessToken: "at-456",
    expiresAt: 1_900_000_000_000,
    seedHash: "abc123",
  };

  it("round-trips save and load", () => {
    save(sample);
    expect(load()).toEqual(sample);
  });

  it("load returns null for missing file", () => {
    expect(load()).toBeNull();
  });

  it("load returns null and warns on corrupt JSON", () => {
    writeFileSync(getCachePath(), "{not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(load()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("load returns null on schema drift (missing fields)", () => {
    writeFileSync(getCachePath(), JSON.stringify({ refreshToken: "x" }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(load()).toBeNull();
    warn.mockRestore();
  });

  it("clear removes the file and is idempotent", () => {
    save(sample);
    clear();
    expect(load()).toBeNull();
    expect(() => clear()).not.toThrow();
  });

  it("hashSeed is deterministic and differs per input", () => {
    expect(hashSeed("same")).toBe(hashSeed("same"));
    expect(hashSeed("a")).not.toBe(hashSeed("b"));
    expect(hashSeed("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("honors SKYLIGHT_CACHE_DIR override", () => {
    expect(getCachePath()).toBe(join(tmp, "token.json"));
  });

  it.skipIf(process.platform === "win32")(
    "saved file has mode 0o600 on POSIX",
    () => {
      save(sample);
      const mode = statSync(getCachePath()).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  );
});
