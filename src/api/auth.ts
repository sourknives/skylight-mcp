/**
 * Skylight Authentication
 * Handles login via email/password to obtain API token
 */

const BASE_URL = "https://app.ourskylight.com";

export interface LoginResponse {
  data: {
    id: string;
    type: "authenticated_user";
    attributes: {
      email: string;
      token: string;
      subscription_status: string;
    };
  };
  meta?: {
    password_reset?: boolean;
  };
}

export interface AuthResult {
  userId: string;
  email: string;
  token: string;
  subscriptionStatus: string;
}

/**
 * Login to Skylight with email and password
 * Returns the authentication token and user info
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const response = await fetch(`${BASE_URL}/api/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error("Invalid email or password");
    }
    throw new Error(`Login failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as LoginResponse;

  return {
    userId: data.data.id,
    email: data.data.attributes.email,
    token: data.data.attributes.token,
    subscriptionStatus: data.data.attributes.subscription_status,
  };
}

// Cache for auth result
let cachedAuth: AuthResult | null = null;

/**
 * Get cached auth result or login if needed
 */
export async function getAuth(email: string, password: string): Promise<AuthResult> {
  if (cachedAuth) {
    return cachedAuth;
  }

  cachedAuth = await login(email, password);
  return cachedAuth;
}

/**
 * Clear cached auth (for re-login)
 */
export function clearAuthCache(): void {
  cachedAuth = null;
}
