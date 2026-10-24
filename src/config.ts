/**
 * Runtime configuration, read once from the environment.
 */

function parseList(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

const port = Number(process.env.PORT ?? 8787);

/** Hostnames Vercel assigns this deployment (production domain, branch alias, unique deployment URL) */
const vercelHosts = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL].filter(
  (host): host is string => Boolean(host)
);

export const config = {
  /** Base URL of the Spur backend, without the /api suffix, e.g. https://api.spur.example */
  spurApiUrl: (process.env.SPUR_API_URL || "http://localhost:3001").replace(/\/+$/, ""),
  /** Public URL the MCP endpoint is reachable at; used as the OAuth issuer and resource id */
  publicUrl: (
    process.env.MCP_PUBLIC_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${port}`)
  ).replace(/\/+$/, ""),
  port,
  // A localhost host also restricts request Origins to localhost, so serverless (no bind at all) uses 0.0.0.0
  host: process.env.HOST || (process.env.VERCEL ? "0.0.0.0" : "127.0.0.1"),
  /** Extra Host header names accepted when binding beyond localhost */
  allowedHosts: [...parseList(process.env.MCP_ALLOWED_HOSTS), ...vercelHosts],
  /**
   * Secret used to seal OAuth codes and tokens (AES-256-GCM). Must be at least 32 chars in production.
   * Rotating it signs every connected client out.
   */
  tokenSecret: process.env.MCP_TOKEN_SECRET || "",
  /**
   * Supabase project behind Spur's Google sign-in (the web app's VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).
   * When both are set, the sign-in page offers "Continue with Google".
   */
  supabaseUrl: (process.env.SUPABASE_URL || "").replace(/\/+$/, ""),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  /** stdio mode only: a Spur access token for a single local user */
  stdioAccessToken: process.env.SPUR_ACCESS_TOKEN || "",
  /** stdio mode only: a Spur refresh token so long local sessions keep working */
  stdioRefreshToken: process.env.SPUR_REFRESH_TOKEN || "",
  /** Map tiles for the results widget; {s},{z},{x},{y} placeholders as in Leaflet */
  mapTileUrl: process.env.MAP_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  mapTileAttribution:
    process.env.MAP_TILE_ATTRIBUTION ||
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  /**
   * Over HTTP, widgets load tiles through this server's caching proxy (src/tiles.ts) so upstream requests
   * are identified, cached and rate-limited. stdio has no HTTP server, so widgets fetch MAP_TILE_URL directly.
   */
  mapTileProxy: process.env.TRANSPORT !== "stdio",
  /** Contact (email or URL) sent in the tile proxy's User-Agent, as the OpenStreetMap tile policy asks */
  mapTileContact: process.env.MAP_TILE_CONTACT || "",
  mapTileCacheMb: Number(process.env.MAP_TILE_CACHE_MB) || 256,
  mapTileUpstreamConcurrency: Number(process.env.MAP_TILE_UPSTREAM_CONCURRENCY) || 4,
  /** Tile requests one client IP may make per 5 minutes */
  mapTileClientLimit: Number(process.env.MAP_TILE_CLIENT_LIMIT) || 1500,
  mapTileMaxZoom: 19,
  /** Extra origins widgets may load images from (postcard artwork CDNs, etc.) */
  widgetImageDomains: parseList(process.env.WIDGET_IMAGE_DOMAINS)
};

export const CHARACTER_LIMIT = 25_000;
export const SERVER_NAME = "spur-mcp-server";
export const SERVER_VERSION = "1.0.0";
