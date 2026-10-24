/**
 * MCP Apps UI resources. One implementation serves both hosts: Claude renders MCP Apps natively,
 * and ChatGPT's Apps SDK renders the same `ui://` resources (MCP Apps is its standard widget format).
 * The legacy `openai/*` resource keys are added so older ChatGPT builds apply the same CSP.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { config } from "./config.js";
import { TILE_PROXY_PATH } from "./tiles.js";

export const PROPERTY_EXPLORER_URI = "ui://spur/property-explorer-v1.html";
export const POSTCARD_PREVIEW_URI = "ui://spur/postcard-preview-v2.html";
/** Result `_meta` key carrying the postcard artwork with images inlined (read by postcard-preview.ts) */
export const POSTCARD_ARTWORK_META = "spur/postcard_artwork";
export const MESSAGE_PREVIEW_URI = "ui://spur/message-preview-v1.html";
/** Result `_meta` key carrying rendered email HTML with images inlined (read by message-preview.ts) */
export const MESSAGE_HTML_META = "spur/message_html";
export const BILLING_URI = "ui://spur/billing-v1.html";
export const IMAGE_UPLOAD_URI = "ui://spur/image-upload-v1.html";

const here = dirname(fileURLToPath(import.meta.url));
// dist/widgets.js → dist/views; src/widgets.ts (tsx dev) → dist/views
const VIEW_DIRS = [join(here, "views"), join(here, "..", "dist", "views")];

const htmlCache = new Map<string, string>();

/** Tile template the widget loads: this server's caching proxy over HTTP, the provider directly on stdio */
const widgetTileUrl = () => (config.mapTileProxy ? `${config.publicUrl}${TILE_PROXY_PATH}` : config.mapTileUrl);

function loadView(name: string): string {
  const cached = htmlCache.get(name);
  if (cached) return cached;
  const dir = VIEW_DIRS.find(candidate => existsSync(join(candidate, name)));
  if (!dir) throw new Error(`Widget ${name} is not built. Run "npm run build:views" in mcp/.`);
  const html = readFileSync(join(dir, name), "utf8").replace(
    "<!--SPUR_CONFIG-->",
    // Server-side settings the view needs; JSON-escaped so it cannot break out of the script tag
    `<script>window.__SPUR__=${JSON.stringify({
      tileUrl: widgetTileUrl(),
      tileAttribution: config.mapTileAttribution,
      appUrl: process.env.SPUR_APP_URL || ""
    }).replace(/</g, "\\u003c")}</script>`
  );
  htmlCache.set(name, html);
  return html;
}

/** Leaflet-style tile templates → CSP origins, e.g. https://{s}.tile.x.org → https://*.tile.x.org */
function tileOrigins(template: string): string[] {
  try {
    const url = new URL(template.replace(/\{s\}/g, "a").replace(/\{[a-z]+\}/gi, "0"));
    const origin = url.origin;
    return template.includes("{s}") ? [origin.replace("://a.", "://*.")] : [origin];
  } catch {
    return [];
  }
}

function originOf(url: string): string[] {
  try {
    return [new URL(url).origin];
  } catch {
    return [];
  }
}

const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export function registerWidgets(server: McpServer) {
  const explorerDomains = unique([
    ...tileOrigins(widgetTileUrl()),
    "https://photos.zillowstatic.com",
    "https://maps.zillowstatic.com",
    ...config.widgetImageDomains
  ]);
  const postcardDomains = unique([
    ...originOf(config.spurApiUrl),
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    // Stock photos in Spur's default templates, in case server-side inlining skipped one
    "https://images.pexels.com",
    "https://images.unsplash.com",
    ...config.widgetImageDomains
  ]);

  const views = [
    {
      name: "Spur property explorer",
      uri: PROPERTY_EXPLORER_URI,
      file: "property-explorer.html",
      description: "Map and cards for Spur property search results and saved properties",
      domains: explorerDomains
    },
    {
      name: "Spur postcard preview",
      uri: POSTCARD_PREVIEW_URI,
      file: "postcard-preview.html",
      description: "Postcard (front/back) and letter page preview with merge data, cost estimate and a send button",
      domains: postcardDomains
    },
    {
      name: "Spur email and SMS preview",
      uri: MESSAGE_PREVIEW_URI,
      file: "message-preview.html",
      description: "Email inbox preview (desktop/mobile, HTML and plain text) and SMS phone preview with segment count and design checks",
      // Images are inlined server-side; these cover web fonts and anything inlining skipped
      domains: postcardDomains
    },
    {
      name: "Spur billing",
      uri: BILLING_URI,
      file: "billing.html",
      description: "Wallet balance with one-click top-ups, plan cards with Upgrade buttons, and Stripe checkout links",
      // Self-contained; Stripe pages open in the user's browser through the host, never inside the widget
      domains: [] as string[]
    },
    {
      name: "Spur image upload",
      uri: IMAGE_UPLOAD_URI,
      file: "image-upload.html",
      description: "Pick or drop an image from your device to save it to your Spur image library for postcards, letters and emails",
      // Thumbnails are data: URIs of the picked file; uploads go through the host's tool calls
      domains: [] as string[]
    }
  ];

  for (const view of views) {
    const ui = { csp: { resourceDomains: view.domains, connectDomains: [] as string[] }, prefersBorder: true };
    registerAppResource(server, view.name, view.uri, { description: view.description, _meta: { ui } }, async () => ({
      contents: [
        {
          uri: view.uri,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadView(view.file),
          _meta: {
            ui,
            "openai/widgetCSP": { resource_domains: view.domains, connect_domains: [] },
            "openai/widgetPrefersBorder": true,
            "openai/widgetDescription": view.description
          }
        }
      ]
    }));
  }
}

/** `_meta` for tools that render a widget */
export const widgetMeta = (uri: string, invoking: string, invoked: string) => ({
  ui: { resourceUri: uri },
  "openai/toolInvocation/invoking": invoking,
  "openai/toolInvocation/invoked": invoked
});
