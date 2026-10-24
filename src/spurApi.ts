/**
 * Thin client for the Spur REST API. Every tool goes through `SpurClient.request`,
 * so auth, timeouts and error wording live in one place.
 */
import { config } from "./config.js";

export type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

/** Keeps the HTTP status and Spur's error code so callers can branch on them */
export class SpurApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

function describeFailure(status: number, serverMessage: string | undefined, code: string | undefined): string {
  const detail = serverMessage ? ` Spur said: "${serverMessage}"` : "";
  if (status === 402 || code?.startsWith("BILLING_")) {
    return `Billing limit reached.${detail} Call spur_show_billing_options to show the balance and plan limits with one-click top-up and upgrade buttons, or spur_top_up_wallet / spur_change_plan to get a Stripe checkout link directly.`;
  }
  switch (status) {
    case 400:
      return `Spur rejected the request.${detail} Check the arguments and try again.`;
    case 401:
      return "Your Spur session has expired. Reconnect the Spur connector to sign in again.";
    case 403:
      return `Permission denied: your Spur account cannot do this.${detail}`;
    case 404:
      return `Not found.${detail} Use a list or search tool to get a valid id.`;
    case 409:
      return `Conflict.${detail}`;
    case 429:
      return "Spur is rate limiting requests. Wait a minute and try again.";
    case 503:
      return `A Spur provider is temporarily unavailable.${detail} Try again shortly.`;
    default:
      return `Spur returned HTTP ${status}.${detail}`;
  }
}

export interface TokenRefresher {
  /** Returns a fresh access token, or null when the session cannot be renewed */
  refresh(): Promise<string | null>;
}

export class SpurClient {
  constructor(
    private accessToken: string,
    private readonly refresher?: TokenRefresher
  ) {}

  /**
   * Calls `/api{path}` and returns the parsed JSON body. Spur wraps most payloads as
   * `{ success, data }`; use `data()` to unwrap those.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(method, path, options);
    if (response.status === 401 && this.refresher) {
      const fresh = await this.refresher.refresh();
      if (fresh) {
        this.accessToken = fresh;
        return this.parse<T>(await this.send(method, path, options));
      }
    }
    return this.parse<T>(response);
  }

  /** `request` + unwrap Spur's `{ success, data }` envelope */
  async data<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const body = await this.request<{ data?: T }>(method, path, options);
    return (body && typeof body === "object" && "data" in body ? body.data : body) as T;
  }

  /**
   * Emails the Spur team about an unexpected tool failure, tagged with this session's user.
   * Best effort: never throws, and never refreshes the session.
   */
  async reportError(report: { message: string; stack?: string; location?: string; context?: Record<string, unknown> }): Promise<void> {
    try {
      await this.send("POST", "/error-reports", { body: { source: "mcp", ...report }, signal: AbortSignal.timeout(10_000) });
    } catch {
      // Reporting must never mask the original error
    }
  }

  private async send(method: string, path: string, { query, body, signal }: RequestOptions): Promise<Response> {
    const url = new URL(`${config.spurApiUrl}/api${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const timeout = AbortSignal.timeout(60_000);
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json",
          "X-Spur-Client": "mcp",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("Spur did not respond within 60 seconds. Try again, or narrow the request.");
      }
      throw new Error(`Could not reach Spur at ${config.spurApiUrl}: ${(error as Error).message}`);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Non-JSON body (proxy error page, etc.)
    }
    if (!response.ok) {
      const errorBody = (json || {}) as { error?: string; message?: string; code?: string };
      const serverMessage = errorBody.error || errorBody.message;
      throw new SpurApiError(response.status, describeFailure(response.status, serverMessage, errorBody.code), errorBody.code);
    }
    return json as T;
  }
}

/** Unauthenticated calls used by the OAuth bridge (login, MFA, refresh) */
export async function spurAuthCall<T>(path: string, body: unknown, clientIp?: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${config.spurApiUrl}/api/auth${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Spur-Client": "mcp",
      // Lets Spur rate-limit and audit sign-ins per end user instead of per MCP host
      ...(clientIp ? { "X-Forwarded-For": clientIp } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { success: false, error: `Unexpected response from Spur (HTTP ${response.status})` };
  }
  return { status: response.status, body: parsed as T };
}
