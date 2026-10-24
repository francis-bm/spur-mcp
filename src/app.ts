/**
 * The HTTP app (remote connector for Claude and ChatGPT), without listening on a port.
 * src/index.ts listens on it for a long-running server; api/index.js exports it as a Vercel function.
 */
import { randomBytes } from "node:crypto";
import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import { mcpResourceUrl, oauthMetadata, SpurOAuthBridge } from "./auth/oauth.js";
import { Sealer } from "./auth/seal.js";
import { config, SERVER_NAME } from "./config.js";
import { createSpurServer } from "./server.js";
import { SpurClient } from "./spurApi.js";
import { tileRouter } from "./tiles.js";

export const isLocalUrl = (url: string) => ["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname);

/**
 * JSON-RPC methods served without a token, so directory indexers can run the handshake and list tools.
 * None of them reach the Spur API; everything else (tools/call, resources/read, ...) still gets the 401 challenge.
 */
const DISCOVERY_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list"
]);

export function isDiscoveryRequest(method: string, body: unknown): boolean {
  if (method !== "POST") return false;
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(m => typeof m === "object" && m !== null && typeof (m as { method?: unknown }).method === "string" && DISCOVERY_METHODS.has((m as { method: string }).method))
  );
}

export function resolveTokenSecret(): string {
  if (config.tokenSecret.length >= 32) return config.tokenSecret;
  // stdio only seals short-lived postcard confirmations, so a per-process secret is enough there
  if (process.env.TRANSPORT === "stdio") return randomBytes(32).toString("hex");
  if (isLocalUrl(config.publicUrl)) {
    console.error("MCP_TOKEN_SECRET not set; using a random per-process secret (connectors must sign in again after a restart).");
    return randomBytes(32).toString("hex");
  }
  console.error("MCP_TOKEN_SECRET must be set to at least 32 random characters when MCP_PUBLIC_URL is not localhost.");
  process.exit(1);
}

export function createHttpApp(sealer: Sealer) {
  const bridge = new SpurOAuthBridge(sealer);
  const resource = mcpResourceUrl();
  const publicHost = new URL(config.publicUrl).hostname;

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: [...new Set([publicHost, "localhost", "127.0.0.1", ...config.allowedHosts])],
    jsonLimit: "2mb"
  });
  // Behind a load balancer: use X-Forwarded-For for the end user's IP (sign-in rate limits, audit)
  app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, server: SERVER_NAME });
  });
  // Glama directory ownership claim for the connector listing (public by design)
  app.get("/.well-known/glama.json", (_req, res) => {
    res.json({
      $schema: "https://glama.ai/mcp/schemas/connector.json",
      claim: "glama_claim_hzzfMvzytMe60xmG6VIWdqD2eMmPkjg4"
    });
  });
  // Public: widgets load map tiles from here (no auth, rate-limited per client)
  app.use(tileRouter());
  if (!config.mapTileContact && !isLocalUrl(config.publicUrl)) {
    console.error("MAP_TILE_CONTACT is not set; the OpenStreetMap tile policy asks for contact details in the User-Agent.");
  }

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: oauthMetadata(),
      resourceServerUrl: resource,
      resourceName: "Spur",
      scopesSupported: ["spur"]
    })
  );
  app.use(bridge.router());

  const handler = createMcpHandler(({ authInfo }) => {
    const accessToken = authInfo?.extra?.spurAccessToken;
    // Unauthenticated discovery: the tool handlers never run, so the client is never used
    if (!authInfo) return createSpurServer(new SpurClient(""), sealer);
    if (typeof accessToken !== "string") throw new Error("Missing Spur session on authenticated request");
    return createSpurServer(new SpurClient(accessToken), sealer);
  });
  const nodeHandler = toNodeHandler(handler);
  const requireAuth = requireBearerAuth({
    verifier: bridge.verifier,
    requiredScopes: ["spur"],
    expectedResource: resource,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource)
  });
  app.all(
    "/mcp",
    (req, res, next) => {
      // A client that sends a token gets it verified, even on discovery calls
      if (!req.headers.authorization && isDiscoveryRequest(req.method, req.body)) return next();
      return requireAuth(req, res, next);
    },
    (req, res) => void nodeHandler(req, res, req.body)
  );

  return app;
}
