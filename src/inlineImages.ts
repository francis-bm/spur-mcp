/**
 * Inlines a postcard's remote images as data: URIs for the preview widget.
 *
 * Widgets run under a fixed CSP (see widgets.ts), but template artwork comes from anywhere: stock
 * photo CDNs, the user's uploads in Supabase storage, Spur's QR image endpoint. Fetching them here
 * means the preview renders on every host without allow-listing each origin.
 */
import { isIP } from "node:net";
import { config } from "./config.js";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_HTML_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const CONCURRENCY = 6;
const CACHE_MAX_BYTES = 48 * 1024 * 1024;

/** Allowed directly by the widget CSP; fonts are never images */
const SKIP_ORIGINS = new Set(["https://fonts.googleapis.com", "https://fonts.gstatic.com"]);

const IMG_TAG = /<img\b[^>]*>/gi;
const SRC_ATTR = /(\ssrc\s*=\s*)(["'])([^"']*)\2/i;
const CSS_URL = /url\(\s*(["']?)(https?:\/\/[^"')\s]+)\1\s*\)/gi;
const HAS_VARIABLE = /\{\{[^}]*\}\}/;

const cache = new Map<string, string>();
let cacheBytes = 0;

function remember(url: string, dataUri: string) {
  cache.set(url, dataUri);
  cacheBytes += dataUri.length;
  for (const [key, value] of cache) {
    if (cacheBytes <= CACHE_MAX_BYTES) break;
    cache.delete(key);
    cacheBytes -= value.length;
  }
}

const attr = (tag: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(tag)?.[2];
const decodeEntities = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * QR images are merge placeholders ({{qrUrl}}) until a send mints per-recipient codes; the editor
 * stores a sample image in data-spur-qr-preview-src, which is what the Spur app's previews show too.
 */
function resolveQrPlaceholders(html: string): string {
  return html.replace(IMG_TAG, tag => {
    const previewSrc = attr(tag, "data-spur-qr-preview-src");
    if (!previewSrc) return tag;
    const src = attr(tag, "src");
    if (src && !HAS_VARIABLE.test(src)) return tag;
    return SRC_ATTR.test(tag) ? tag.replace(SRC_ATTR, (_m, prefix, quote) => `${prefix}${quote}${previewSrc}${quote}`) : tag.replace(/^<img\b/i, `<img src="${previewSrc}"`);
  });
}

/** Template HTML is user/model authored, so only fetch public https hosts (plus Spur's own API) */
function isFetchable(url: URL): boolean {
  if (url.origin === new URL(config.spurApiUrl).origin) return true;
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !isIP(host) && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".internal") && host.includes(".");
}

/**
 * Downloads an image from a public URL (same host rules as preview inlining, checked on every
 * redirect). Undefined when it isn't reachable, isn't an image, or is larger than maxBytes.
 */
export async function fetchRemoteImage(raw: string, maxBytes = MAX_IMAGE_BYTES, timeoutMs = FETCH_TIMEOUT_MS): Promise<{ type: string; body: Buffer } | undefined> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isFetchable(url)) return undefined;
      // Redirects are followed by hand so every hop passes the same host check
      const res = await fetch(url, { redirect: "manual", headers: { accept: "image/*" }, signal: AbortSignal.timeout(timeoutMs) });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }
      const type = (res.headers.get("content-type") || "").split(";")[0]?.trim().toLowerCase() || "";
      if (!res.ok || !type.startsWith("image/")) return undefined;
      if (Number(res.headers.get("content-length") || 0) > maxBytes) return undefined;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.length > maxBytes) return undefined;
      return { type, body };
    }
  } catch {
    // Unreachable or slow
  }
  return undefined;
}

async function fetchDataUri(raw: string): Promise<string | undefined> {
  const cached = cache.get(raw);
  if (cached) return cached;
  // Unreachable or slow images keep their URL; the widget shows them if its CSP allows the origin
  const image = await fetchRemoteImage(raw);
  if (!image) return undefined;
  const dataUri = `data:${image.type};base64,${image.body.toString("base64")}`;
  remember(raw, dataUri);
  return dataUri;
}

/** Returns the HTML with QR placeholders resolved and every reachable remote image inlined */
export async function inlineImages(html: string): Promise<string> {
  if (!html) return html;
  const resolved = resolveQrPlaceholders(html);

  // Raw (entity-encoded) text as it appears in the HTML → URL to fetch
  const found = new Map<string, string>();
  const add = (raw: string) => {
    const url = decodeEntities(raw.trim());
    if (!/^https?:\/\//i.test(url) || HAS_VARIABLE.test(url)) return;
    try {
      if (SKIP_ORIGINS.has(new URL(url).origin)) return;
    } catch {
      return;
    }
    found.set(raw, url);
  };
  for (const tag of resolved.match(IMG_TAG) || []) {
    const src = SRC_ATTR.exec(tag)?.[3];
    if (src) add(src);
  }
  for (const match of resolved.matchAll(CSS_URL)) add(match[2] as string);
  if (!found.size) return resolved;

  const entries = [...found];
  const inlined = new Map<string, string>();
  let budget = MAX_HTML_IMAGE_BYTES;
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [raw, url] = entries[next++] as [string, string];
      const dataUri = await fetchDataUri(url);
      if (dataUri && dataUri.length <= budget) {
        budget -= dataUri.length;
        inlined.set(raw, dataUri);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  if (!inlined.size) return resolved;

  return resolved
    .replace(IMG_TAG, tag => tag.replace(SRC_ATTR, (whole, prefix, quote, src) => (inlined.has(src) ? `${prefix}${quote}${inlined.get(src)}${quote}` : whole)))
    .replace(CSS_URL, (whole, quote, url) => (inlined.has(url) ? `url(${quote}${inlined.get(url)}${quote})` : whole));
}
