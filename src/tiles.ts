/**
 * Caching map tile proxy for the property explorer. Widgets load tiles from `/tiles/{z}/{x}/{y}.png`
 * here instead of from the tile server, which is what the OpenStreetMap tile usage policy asks of
 * production apps (https://operations.osmfoundation.org/policies/tiles/):
 *
 * - every upstream request carries an identifying User-Agent with contact details, and a Referer;
 * - tiles are cached and revalidated with conditional requests, so each tile is fetched once per
 *   cache lifetime no matter how many users view it;
 * - upstream concurrency and per-client request rates are capped, so this is not an open mirror.
 *
 * Switching to a commercial provider is only a MAP_TILE_URL change; API keys in it stay server-side.
 */
import type { Request, Response, Router } from "express";
import express from "express";
import { config, SERVER_NAME, SERVER_VERSION } from "./config.js";

interface CachedTile {
  body: Buffer;
  contentType: string;
  /** Epoch ms after which the tile is revalidated upstream */
  freshUntil: number;
  etag?: string;
  lastModified?: string;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLIENT_MAX_AGE_S = 7 * 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_QUEUED_FETCHES = 500;
const SUBDOMAINS = ["a", "b", "c"];

/** Path template the widget uses; resolved against MCP_PUBLIC_URL */
export const TILE_PROXY_PATH = "/tiles/{z}/{x}/{y}.png";

export function tileUserAgent(): string {
  const contact = config.mapTileContact ? `; ${config.mapTileContact}` : "";
  return `${SERVER_NAME}/${SERVER_VERSION} (+${config.publicUrl}${contact})`;
}

/** max-age from Cache-Control, else Expires, else the default */
function ttlFrom(headers: Headers, now: number): number {
  const maxAge = /max-age=(\d+)/i.exec(headers.get("cache-control") || "");
  if (maxAge) return Number(maxAge[1]) * 1000;
  const expires = Date.parse(headers.get("expires") || "");
  if (!Number.isNaN(expires)) return Math.max(0, expires - now);
  return DEFAULT_TTL_MS;
}

/** Byte-capped LRU: Map keeps insertion order, so re-inserting on read moves an entry to the end */
class TileCache {
  private entries = new Map<string, CachedTile>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): CachedTile | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CachedTile) {
    const existing = this.entries.get(key);
    if (existing) {
      this.bytes -= existing.body.length;
      this.entries.delete(key);
    }
    if (entry.body.length > this.maxBytes) return;
    this.entries.set(key, entry);
    this.bytes += entry.body.length;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.body.length;
    }
  }
}

/** Limits concurrent upstream fetches; callers beyond the queue limit are turned away */
class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= MAX_QUEUED_FETCHES) throw new TileError(503, "Tile server busy");
      // The finishing task hands its slot straight to us, so `active` is not incremented here
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Fixed-window request counter per client IP */
class ClientLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly max: number, private readonly windowMs: number) {}

  allow(key: string, now: number): boolean {
    if (this.windows.size > 50_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    window.count++;
    return window.count <= this.max;
  }
}

class TileError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function upstreamUrl(z: number, x: number, y: number): string {
  return config.mapTileUrl
    .replace(/\{s\}/g, SUBDOMAINS[(x + y) % SUBDOMAINS.length])
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{r\}/g, "");
}

export function tileRouter(): Router {
  const cache = new TileCache(config.mapTileCacheMb * 1024 * 1024);
  const upstream = new Semaphore(config.mapTileUpstreamConcurrency);
  const clients = new ClientLimiter(config.mapTileClientLimit, 5 * 60 * 1000);
  const inflight = new Map<string, Promise<CachedTile>>();
  let warnedBlocked = false;

  async function fetchTile(key: string, z: number, x: number, y: number, stale?: CachedTile): Promise<CachedTile> {
    const headers: Record<string, string> = {
      "User-Agent": tileUserAgent(),
      Referer: `${config.publicUrl}/`,
      Accept: "image/png,image/*"
    };
    if (stale?.etag) headers["If-None-Match"] = stale.etag;
    if (stale?.lastModified) headers["If-Modified-Since"] = stale.lastModified;

    const { response, body } = await upstream.run(async () => {
      const res = await fetch(upstreamUrl(z, x, y), { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
      return { response: res, body: res.ok ? Buffer.from(await res.arrayBuffer()) : undefined };
    });
    const now = Date.now();
    if (response.status === 304 && stale) {
      const refreshed = { ...stale, freshUntil: now + ttlFrom(response.headers, now) };
      cache.set(key, refreshed);
      return refreshed;
    }
    if (response.status === 404) throw new TileError(404, "Tile not found");
    if (!response.ok || !body) {
      if ((response.status === 403 || response.status === 429) && !warnedBlocked) {
        warnedBlocked = true;
        console.error(`Tile server answered ${response.status}; it may be throttling or blocking this server. Check MAP_TILE_URL and the provider's usage policy.`);
      }
      throw new TileError(502, `Tile server returned ${response.status}`);
    }
    const tile: CachedTile = {
      body,
      contentType: response.headers.get("content-type") || "image/png",
      freshUntil: now + ttlFrom(response.headers, now),
      etag: response.headers.get("etag") || undefined,
      lastModified: response.headers.get("last-modified") || undefined
    };
    cache.set(key, tile);
    return tile;
  }

  function send(res: Response, tile: CachedTile, cacheStatus: string) {
    const maxAge = Math.min(MAX_CLIENT_MAX_AGE_S, Math.max(60, Math.floor((tile.freshUntil - Date.now()) / 1000)));
    res.set({
      "Content-Type": tile.contentType,
      // s-maxage lets a CDN in front of us (Vercel's edge cache) serve repeat requests without reaching this instance
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      // Widgets run in sandboxed iframes on the host's origin
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Access-Control-Allow-Origin": "*",
      "X-Cache": cacheStatus
    });
    res.send(tile.body);
  }

  const router = express.Router();
  router.get("/tiles/:z/:x/:file", async (req: Request, res: Response) => {
    const match = /^(\d+)\.png$/.exec(String(req.params.file));
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = match ? Number(match[1]) : NaN;
    const span = 2 ** z;
    if (
      !/^\d+$/.test(String(req.params.z)) || !/^\d+$/.test(String(req.params.x)) || !match ||
      z > config.mapTileMaxZoom || x >= span || y >= span
    ) {
      res.status(400).json({ error: "Invalid tile coordinates" });
      return;
    }
    if (!clients.allow(req.ip || "unknown", Date.now())) {
      res.status(429).set("Retry-After", "60").json({ error: "Too many tile requests" });
      return;
    }

    const key = `${z}/${x}/${y}`;
    const cached = cache.get(key);
    if (cached && cached.freshUntil > Date.now()) {
      send(res, cached, "HIT");
      return;
    }

    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchTile(key, z, x, y, cached).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    try {
      send(res, await pending, cached ? "REVALIDATED" : "MISS");
    } catch (error) {
      // Serve a stale tile rather than a hole in the map when the tile server is unavailable
      if (cached) {
        send(res, cached, "STALE");
        return;
      }
      const status = error instanceof TileError ? error.status : 502;
      res.status(status).json({ error: error instanceof Error ? error.message : "Tile fetch failed" });
    }
  });
  return router;
}
