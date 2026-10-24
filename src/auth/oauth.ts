/**
 * Stateless OAuth 2.1 authorization server that bridges Claude / ChatGPT connectors to Spur accounts.
 *
 * Flow: the client registers dynamically (RFC 7591) → the user signs in on our page with their
 * Spur credentials (plus MFA when enabled) or with Google → we mint a PKCE-bound code → the client
 * swaps it for an access token. Spur's own JWTs are sealed inside our tokens, so Spur's RBAC, data isolation,
 * session revocation and audit trail all keep applying to every MCP call.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { config } from "../config.js";
import { spurAuthCall } from "../spurApi.js";
import { exchangeGoogleCode, googleAuthorizeUrl, googleEnabled } from "./google.js";
import { errorPage, loginPage, mfaPage } from "./pages.js";
import { jwtExpiry, nowSeconds, type Sealer } from "./seal.js";

const CODE_TTL_SECONDS = 300;
const AUTH_REQUEST_TTL_SECONDS = 900;
const GOOGLE_FLOW_TTL_SECONDS = 600;
/** Carries the PKCE verifier for Supabase across the Google round trip, bound to this browser */
const GOOGLE_COOKIE = "spur_mcp_google";
const GOOGLE_COOKIE_PATH = "/oauth/google";
const SCOPE = "spur";

interface ClientRecord {
  redirect_uris: string[];
  client_name: string;
  iat: number;
}

interface AuthRequest {
  cid: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  resource?: string;
  exp: number;
}

interface GoogleFlow {
  req: string;
  v: string;
  exp: number;
}

interface CodePayload {
  jti: string;
  cid: string;
  redirectUri: string;
  challenge: string;
  sa: string;
  sr: string;
  exp: number;
}

interface AccessPayload {
  sa: string;
  cid: string;
  exp: number;
}

interface RefreshPayload {
  sr: string;
  cid: string;
}

interface SpurLoginResponse {
  success?: boolean;
  error?: string;
  requiresMfa?: boolean;
  mfaMethod?: string;
  challengeToken?: string;
  accessToken?: string;
  refreshToken?: string;
}

export const mcpResourceUrl = () => new URL(`${config.publicUrl}/mcp`);

export function oauthMetadata(): OAuthMetadata {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}/oauth/authorize`,
    token_endpoint: `${config.publicUrl}/oauth/token`,
    registration_endpoint: `${config.publicUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE]
  };
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/** Redirect URIs must be HTTPS, or loopback HTTP for local clients (RFC 8252) */
function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Codes are single-use; remember spent ones until they would have expired anyway. This is per instance,
 * so on serverless a replay could land on another instance; it would still need the client's PKCE verifier.
 */
class SpentCodes {
  private readonly spent = new Map<string, number>();

  consume(jti: string, exp: number): boolean {
    const now = nowSeconds();
    for (const [key, expiry] of this.spent) if (expiry < now) this.spent.delete(key);
    if (this.spent.has(jti)) return false;
    this.spent.set(jti, exp);
    return true;
  }
}

export class SpurOAuthBridge {
  private readonly spentCodes = new SpentCodes();

  constructor(private readonly sealer: Sealer) {}

  readonly verifier: OAuthTokenVerifier = {
    verifyAccessToken: async (token: string): Promise<AuthInfo> => {
      const payload = this.sealer.unseal<AccessPayload>("access", token);
      if (!payload) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown or malformed token");
      if (payload.exp <= nowSeconds()) throw new OAuthError(OAuthErrorCode.InvalidToken, "Token expired");
      return {
        token,
        clientId: payload.cid,
        scopes: [SCOPE],
        expiresAt: payload.exp,
        resource: mcpResourceUrl(),
        extra: { spurAccessToken: payload.sa }
      };
    }
  };

  router(): Router {
    const router = express.Router();
    router.use("/oauth", express.urlencoded({ extended: false, limit: "20kb" }));
    router.post("/oauth/register", (req, res) => this.register(req, res));
    router.get("/oauth/authorize", (req, res) => this.authorizeStart(req, res));
    router.post("/oauth/authorize", (req, res) => void this.authorizeSubmit(req, res));
    router.get("/oauth/google", (req, res) => this.googleStart(req, res));
    router.get("/oauth/google/callback", (req, res) => void this.googleCallback(req, res));
    router.post("/oauth/token", (req, res) => void this.token(req, res));
    return router;
  }

  // ---- Dynamic client registration ----

  private register(req: Request, res: Response) {
    const body = (req.body || {}) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (redirectUris.length === 0 || !redirectUris.every(isAllowedRedirectUri)) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be HTTPS URLs (or http://localhost for local clients)"
      });
      return;
    }
    const clientName = typeof body.client_name === "string" ? body.client_name.slice(0, 100) : "An AI assistant";
    const record: ClientRecord = { redirect_uris: redirectUris, client_name: clientName, iat: nowSeconds() };
    res.status(201).json({
      client_id: this.sealer.seal("client", record),
      client_id_issued_at: record.iat,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    });
  }

  private client(clientId: unknown): ClientRecord | null {
    return typeof clientId === "string" ? this.sealer.unseal<ClientRecord>("client", clientId) : null;
  }

  // ---- Authorization ----

  private authorizeStart(req: Request, res: Response) {
    const q = req.query as Record<string, string | undefined>;
    const client = this.client(q.client_id);
    // Without a valid client + redirect URI we must not redirect anywhere (open-redirect protection)
    if (!client) {
      res.status(400).type("html").send(errorPage("This connector is not registered. Remove it and add it again."));
      return;
    }
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      res.status(400).type("html").send(errorPage("The redirect URL does not match this connector's registration."));
      return;
    }
    const fail = (error: string, description: string) => {
      const url = new URL(q.redirect_uri as string);
      url.searchParams.set("error", error);
      url.searchParams.set("error_description", description);
      if (q.state) url.searchParams.set("state", q.state);
      res.redirect(302, url.toString());
    };
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    }
    if (q.resource && q.resource.replace(/\/$/, "") !== mcpResourceUrl().href.replace(/\/$/, "")) {
      return fail("invalid_target", `Unknown resource; expected ${mcpResourceUrl().href}`);
    }

    const authRequest: AuthRequest = {
      cid: q.client_id as string,
      redirectUri: q.redirect_uri,
      challenge: q.code_challenge,
      state: q.state,
      resource: q.resource,
      exp: nowSeconds() + AUTH_REQUEST_TTL_SECONDS
    };
    this.sendPage(res, loginPage(this.sealer.seal("authreq", authRequest), this.pageOptions(client)));
  }

  private pageOptions(client: ClientRecord) {
    return { clientName: client.client_name, google: googleEnabled() };
  }

  /** The sealed authorize request plus its client, or null (and an error page sent) when it is unusable */
  private openAuthRequest(res: Response, sealed: string | undefined): { authRequest: AuthRequest; client: ClientRecord } | null {
    const authRequest = this.sealer.unseal<AuthRequest>("authreq", sealed);
    const client = authRequest ? this.client(authRequest.cid) : null;
    if (!authRequest || !client || authRequest.exp <= nowSeconds()) {
      res.status(400).type("html").send(errorPage("This sign-in link has expired. Start the connection again from your assistant."));
      return null;
    }
    return { authRequest, client };
  }

  private async authorizeSubmit(req: Request, res: Response) {
    const form = (req.body || {}) as Record<string, string | undefined>;
    const opened = this.openAuthRequest(res, form.req);
    if (!opened) return;
    const { authRequest } = opened;
    const pageOptions = this.pageOptions(opened.client);

    let login: { status: number; body: SpurLoginResponse };
    try {
      if (form.mfa) {
        const challengeToken = this.sealer.unseal<{ t: string; m: string }>("mfa", form.mfa);
        if (!challengeToken) {
          this.sendPage(res, loginPage(form.req as string, { ...pageOptions, error: "Verification expired. Sign in again." }), 400);
          return;
        }
        login = await spurAuthCall<SpurLoginResponse>(
          "/mfa/verify",
          { challengeToken: challengeToken.t, code: (form.code || "").trim() },
          req.ip
        );
        if (!login.body.success) {
          this.sendPage(
            res,
            mfaPage(form.req as string, form.mfa, challengeToken.m, { ...pageOptions, error: login.body.error || "That code didn't work. Try again." }),
            401
          );
          return;
        }
      } else {
        login = await spurAuthCall<SpurLoginResponse>("/login", { email: (form.email || "").trim(), password: form.password || "" }, req.ip);
        if (login.status === 429) {
          this.sendPage(res, loginPage(form.req as string, { ...pageOptions, error: "Too many attempts. Wait 15 minutes and try again." }), 429);
          return;
        }
        if (!login.body.success) {
          this.sendPage(res, loginPage(form.req as string, { ...pageOptions, error: login.body.error || "Email or password is incorrect." }), 401);
          return;
        }
        if (login.body.requiresMfa && login.body.challengeToken) {
          const method = login.body.mfaMethod || "totp";
          const challenge = this.sealer.seal("mfa", { t: login.body.challengeToken, m: method });
          this.sendPage(res, mfaPage(form.req as string, challenge, method, pageOptions));
          return;
        }
      }
    } catch (error) {
      this.sendPage(res, loginPage(form.req as string, { ...pageOptions, error: `Could not reach Spur: ${(error as Error).message}` }), 502);
      return;
    }

    if (!login.body.accessToken || !login.body.refreshToken) {
      this.sendPage(res, loginPage(form.req as string, { ...pageOptions, error: "Spur did not return a session. Try again." }), 502);
      return;
    }
    this.redirectWithCode(res, authRequest, login.body.accessToken, login.body.refreshToken);
  }

  // ---- Google sign-in (through Supabase, like the Spur web app) ----

  private googleStart(req: Request, res: Response) {
    const sealedReq = typeof req.query.req === "string" ? req.query.req : undefined;
    if (!this.openAuthRequest(res, sealedReq)) return;
    if (!googleEnabled()) {
      res.status(400).type("html").send(errorPage("Google sign-in is not set up on this server. Sign in with email instead."));
      return;
    }
    const verifier = randomBytes(32).toString("base64url");
    const flow: GoogleFlow = { req: sealedReq as string, v: verifier, exp: nowSeconds() + GOOGLE_FLOW_TTL_SECONDS };
    res.cookie(GOOGLE_COOKIE, this.sealer.seal("google", flow), {
      httpOnly: true,
      secure: config.publicUrl.startsWith("https:"),
      // Lax so the cookie comes back on the top-level redirect from Google/Supabase
      sameSite: "lax",
      path: GOOGLE_COOKIE_PATH,
      maxAge: GOOGLE_FLOW_TTL_SECONDS * 1000
    });
    res.set("Cache-Control", "no-store").redirect(302, googleAuthorizeUrl(verifier));
  }

  private async googleCallback(req: Request, res: Response) {
    const flow = this.sealer.unseal<GoogleFlow>("google", readCookie(req, GOOGLE_COOKIE));
    res.clearCookie(GOOGLE_COOKIE, { path: GOOGLE_COOKIE_PATH });
    if (!flow || flow.exp <= nowSeconds()) {
      res.status(400).type("html").send(errorPage("This Google sign-in expired or was opened in another browser. Start the connection again from your assistant."));
      return;
    }
    const opened = this.openAuthRequest(res, flow.req);
    if (!opened) return;
    const pageOptions = this.pageOptions(opened.client);
    const retry = (error: string, status: number) => this.sendPage(res, loginPage(flow.req, { ...pageOptions, error }), status);

    const q = req.query as Record<string, string | undefined>;
    if (q.error || !q.code) return retry(q.error_description || "Google sign-in was cancelled.", 400);

    let login: { status: number; body: SpurLoginResponse };
    try {
      const session = await exchangeGoogleCode(q.code, flow.v);
      if (!session) return retry("Google sign-in failed. Try again.", 401);
      const { user } = session;
      const email = (user.email || "").trim();
      if (!email) return retry("Google did not share an email address. Sign in with email and password instead.", 400);
      login = await spurAuthCall<SpurLoginResponse>(
        "/oauth/callback",
        {
          provider: user.app_metadata?.provider || "google",
          providerUserId: user.id,
          email,
          name: user.user_metadata?.full_name || user.user_metadata?.name,
          avatar: user.user_metadata?.avatar_url,
          accessToken: session.accessToken
        },
        req.ip
      );
    } catch (error) {
      return retry(`Could not reach Spur: ${(error as Error).message}`, 502);
    }
    if (!login.body.success) return retry(login.body.error || "Google sign-in failed. Try again.", 401);
    if (!login.body.accessToken || !login.body.refreshToken) return retry("Spur did not return a session. Try again.", 502);
    this.redirectWithCode(res, opened.authRequest, login.body.accessToken, login.body.refreshToken);
  }

  private redirectWithCode(res: Response, authRequest: AuthRequest, spurAccess: string, spurRefresh: string) {
    const code: CodePayload = {
      jti: randomUUID(),
      cid: authRequest.cid,
      redirectUri: authRequest.redirectUri,
      challenge: authRequest.challenge,
      sa: spurAccess,
      sr: spurRefresh,
      exp: nowSeconds() + CODE_TTL_SECONDS
    };
    const url = new URL(authRequest.redirectUri);
    url.searchParams.set("code", this.sealer.seal("code", code));
    if (authRequest.state) url.searchParams.set("state", authRequest.state);
    res.redirect(302, url.toString());
  }

  // ---- Token endpoint ----

  private async token(req: Request, res: Response) {
    res.set("Cache-Control", "no-store");
    const body = (req.body || {}) as Record<string, string | undefined>;
    const fail = (status: number, error: string, description: string) => res.status(status).json({ error, error_description: description });

    if (!this.client(body.client_id)) return fail(401, "invalid_client", "Unknown client_id; register again");

    if (body.grant_type === "authorization_code") {
      const code = this.sealer.unseal<CodePayload>("code", body.code);
      if (!code || code.exp <= nowSeconds()) return fail(400, "invalid_grant", "Authorization code is invalid or expired");
      if (code.cid !== body.client_id) return fail(400, "invalid_grant", "Code was issued to another client");
      if (code.redirectUri !== body.redirect_uri) return fail(400, "invalid_grant", "redirect_uri does not match");
      const verifierHash = createHash("sha256").update(body.code_verifier || "").digest("base64url");
      if (!body.code_verifier || verifierHash !== code.challenge) return fail(400, "invalid_grant", "PKCE verification failed");
      if (!this.spentCodes.consume(code.jti, code.exp)) return fail(400, "invalid_grant", "Authorization code was already used");
      return res.json(this.issueTokens(code.cid, code.sa, code.sr));
    }

    if (body.grant_type === "refresh_token") {
      const refresh = this.sealer.unseal<RefreshPayload>("refresh", body.refresh_token);
      if (!refresh || refresh.cid !== body.client_id) return fail(400, "invalid_grant", "Refresh token is invalid");
      try {
        const renewed = await spurAuthCall<SpurLoginResponse>("/refresh", { refreshToken: refresh.sr });
        if (!renewed.body.success || !renewed.body.accessToken || !renewed.body.refreshToken) {
          return fail(400, "invalid_grant", renewed.body.error || "Spur session ended; sign in again");
        }
        return res.json(this.issueTokens(refresh.cid, renewed.body.accessToken, renewed.body.refreshToken));
      } catch (error) {
        return fail(503, "temporarily_unavailable", `Could not reach Spur: ${(error as Error).message}`);
      }
    }

    return fail(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  /**
   * Our access token lives exactly as long as the Spur access token inside it. The client then
   * refreshes through us, which rotates the Spur refresh token in one place (no double use).
   */
  private issueTokens(clientId: string, spurAccess: string, spurRefresh: string) {
    const exp = Math.max(nowSeconds() + 60, (jwtExpiry(spurAccess) ?? nowSeconds() + 900) - 30);
    return {
      access_token: this.sealer.seal("access", { sa: spurAccess, cid: clientId, exp } satisfies AccessPayload),
      token_type: "Bearer",
      expires_in: exp - nowSeconds(),
      refresh_token: this.sealer.seal("refresh", { sr: spurRefresh, cid: clientId } satisfies RefreshPayload),
      scope: SCOPE
    };
  }

  private sendPage(res: Response, html: string, status = 200) {
    res
      .status(status)
      .set({
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
        "Cache-Control": "no-store"
      })
      .type("html")
      .send(html);
  }
}
