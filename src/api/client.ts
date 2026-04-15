import { getConfig, type Config } from "../config.js";
import { refreshAccessToken, type AuthResult } from "./auth.js";
import {
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SkylightError,
} from "../utils/errors.js";

const BASE_URL = "https://app.ourskylight.com";

/** Refresh access token this many ms before it actually expires. */
const REFRESH_LEEWAY_MS = 60_000;

export type SubscriptionStatus = "plus" | "free" | "trial" | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | boolean | number | undefined>;
  body?: unknown;
}

export class SkylightClient {
  private config: Config;
  private auth: AuthResult | null = null;
  private refreshPromise: Promise<AuthResult> | null = null;
  private subscriptionStatus: SubscriptionStatus = null;

  constructor(config?: Config) {
    this.config = config ?? getConfig();
  }

  /**
   * Ensure we have a non-expired access token. Refreshes if needed.
   * Single-flighted so concurrent requests share one refresh.
   */
  private async ensureAccessToken(forceRefresh = false): Promise<AuthResult> {
    if (!forceRefresh && this.auth && this.auth.expiresAt - REFRESH_LEEWAY_MS > Date.now()) {
      return this.auth;
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const result = await refreshAccessToken({
          clientId: this.config.clientId,
          refreshToken: this.config.refreshToken,
          fingerprint: this.config.fingerprint,
        });
        this.auth = result;
        return result;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  private async getAuthHeader(forceRefresh = false): Promise<string> {
    const auth = await this.ensureAccessToken(forceRefresh);
    return `Bearer ${auth.accessToken}`;
  }

  private buildUrl(endpoint: string, params?: Record<string, string | boolean | number | undefined>): string {
    const url = new URL(endpoint, BASE_URL);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  private async handleResponseError(response: Response, url: string): Promise<never> {
    const status = response.status;

    if (status === 401) {
      this.auth = null;
      console.error(`[client] 401 Unauthorized for ${url}`);
      throw new AuthenticationError(
        "API request returned 401 even after refreshing the access token. " +
          "Re-bootstrap SKYLIGHT_REFRESH_TOKEN from the Skylight web app, or " +
          "verify SKYLIGHT_CLIENT_ID / SKYLIGHT_FINGERPRINT / SKYLIGHT_FRAME_ID."
      );
    }

    if (status === 404) {
      throw new NotFoundError("Resource");
    }

    if (status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
    }

    let errorMessage = `HTTP ${status}`;
    try {
      const errorBody = await response.text();
      if (errorBody) {
        errorMessage += `: ${errorBody.slice(0, 200)}`;
      }
    } catch {
      // ignore
    }

    throw new SkylightError(errorMessage, "HTTP_ERROR", status, status >= 500);
  }

  async request<T>(endpoint: string, options: RequestOptions = {}, isRetry = false): Promise<T> {
    const { method = "GET", params, body } = options;

    const resolvedEndpoint = endpoint.replace("{frameId}", this.config.frameId);
    const url = this.buildUrl(resolvedEndpoint, params);

    console.error(`[client] ${method} ${url}`);

    const headers: Record<string, string> = {
      Authorization: await this.getAuthHeader(isRetry),
      Accept: "application/json",
    };

    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    console.error(`[client] Response: ${response.status}`);

    if (!response.ok) {
      // Force a refresh and retry once on 401 (handles tokens revoked
      // mid-flight or clock skew).
      if (response.status === 401 && !isRetry) {
        console.error("[client] Got 401, forcing token refresh and retrying...");
        this.auth = null;
        return this.request<T>(endpoint, options, true);
      }
      await this.handleResponseError(response, url);
    }

    if (response.status === 304) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  async get<T>(endpoint: string, params?: Record<string, string | boolean | number | undefined>): Promise<T> {
    return this.request<T>(endpoint, { method: "GET", params });
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, { method: "POST", body });
  }

  get frameId(): string {
    return this.config.frameId;
  }

  get timezone(): string {
    return this.config.timezone;
  }

  hasPlus(): boolean {
    return this.subscriptionStatus === "plus";
  }

  getSubscriptionStatus(): SubscriptionStatus {
    return this.subscriptionStatus;
  }

  /**
   * Initialize the client: do an initial OAuth refresh, then probe /api/user
   * to discover subscription status (used to gate Plus-only tool registration).
   */
  async initialize(): Promise<void> {
    await this.ensureAccessToken();
    try {
      const userResp = await this.get<{
        data: { id: string; attributes: { subscription_status?: string } };
      }>("/api/user");
      const status = userResp?.data?.attributes?.subscription_status;
      if (status === "plus" || status === "free" || status === "trial") {
        this.subscriptionStatus = status;
      }
      console.error(`[client] Authenticated; subscription_status=${status ?? "unknown"}`);
    } catch (err) {
      console.error(`[client] Warning: /api/user probe failed: ${(err as Error).message}`);
    }
  }
}

let clientInstance: SkylightClient | null = null;

export function getClient(): SkylightClient {
  if (!clientInstance) {
    clientInstance = new SkylightClient();
  }
  return clientInstance;
}

export async function initializeClient(): Promise<SkylightClient> {
  const client = getClient();
  await client.initialize();
  return client;
}
