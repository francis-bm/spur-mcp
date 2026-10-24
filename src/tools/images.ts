/**
 * The user's image library (Spur → Direct Mail → image picker, /api/assets): list it, save new
 * images from a URL or from the user's device, and delete them. Saved images have public https
 * URLs that postcards, letters and emails can use directly in <img src>.
 *
 * Assistants can't hand an image attached in chat to a tool, so device uploads go through the
 * uploader widget: the user picks a file, the widget calls spur_save_uploaded_image with its bytes.
 * Bytes reach storage the way the web app sends them: a signed upload URL, then /assets/complete.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { fetchRemoteImage } from "../inlineImages.js";
import type { SpurClient } from "../spurApi.js";
import { IMAGE_UPLOAD_URI, widgetMeta } from "../widgets.js";
import type { MessageTemplate } from "./messageTemplates.js";
import type { Template } from "./mail.js";
import { bullets, confirmField, date, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

export interface Asset {
  id: string;
  filename: string;
  public_url: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  created_at?: string;
}

/** Same limit as the backend (assetController MAX_SIZE_BYTES) */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Widget uploads travel inside one tool call; hosts and serverless deploys cap request bodies (~4.5 MB) */
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const URL_FETCH_TIMEOUT_MS = 20_000;

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg" };

/** The real type from the file's first bytes; headers and file names can lie */
export function sniffImageType(body: Buffer): string | undefined {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && /^GIF8[79]a$/.test(body.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const head = body.subarray(0, 1024).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "image/svg+xml";
  return undefined;
}

/** A storage-safe name ending in the extension for its real type */
export function imageFilename(name: string | undefined, type: string): string {
  const ext = EXTENSIONS[type] || "img";
  const base = (name || "")
    .split(/[/\\]/)
    .pop()!
    .replace(/\.[a-z0-9]{1,5}$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || `image-${Date.now()}`}.${ext}`;
}

const kb = (bytes: number | null | undefined) => (bytes ? (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : "");

const USAGE = "Use it as <img src=\"…\"> (or a CSS background-image) in postcard, letter or email HTML.";
const EMAIL_SVG_NOTE = "SVG doesn't display in most email clients; use PNG or JPG in emails.";

/** Validates bytes and stores them in the user's library, like the web app's assetsApi.upload */
export async function saveImage(spur: SpurClient, body: Buffer, filename: string | undefined, signal: AbortSignal): Promise<Asset | { error: string }> {
  if (!body.length) return { error: "The image is empty." };
  if (body.length > MAX_IMAGE_BYTES) return { error: "The image is over Spur's 20 MB limit." };
  const type = sniffImageType(body);
  if (!type) return { error: "That isn't a JPG, PNG, WebP, GIF or SVG image." };
  const name = imageFilename(filename, type);
  const upload = await spur.data<{ signed_url: string; storage_path: string }>("POST", "/assets/upload-url", { body: { filename: name, mime_type: type }, signal });
  const put = await fetch(upload.signed_url, { method: "PUT", headers: { "Content-Type": type, "x-upsert": "false" }, body: new Uint8Array(body), signal });
  if (!put.ok) return { error: `Storage upload failed (${put.status}). Try again.` };
  return spur.data<Asset>("POST", "/assets/complete", { body: { storage_path: upload.storage_path }, signal });
}

const assetSummary = (a: Asset) => ({ id: a.id, filename: a.filename, url: a.public_url, mime_type: a.mime_type ?? null, size_bytes: a.size_bytes ?? null, created_at: a.created_at ?? null });

function savedText(asset: Asset, heading: string): string {
  return [
    heading,
    bullets([
      ["URL", asset.public_url],
      ["Type", asset.mime_type],
      ["Size", kb(asset.size_bytes)]
    ]),
    USAGE,
    asset.mime_type === "image/svg+xml" ? EMAIL_SVG_NOTE : ""
  ]
    .filter(Boolean)
    .join("\n");
}

/** The user's templates (mail and email) whose HTML points at this URL */
async function templatesUsing(spur: SpurClient, url: string, signal: AbortSignal): Promise<string[]> {
  const [mail, messages] = await Promise.all([
    spur.data<Template[]>("GET", "/direct-mail/templates", { signal }).catch(() => [] as Template[]),
    spur.data<MessageTemplate[]>("GET", "/communication/templates", { signal }).catch(() => [] as MessageTemplate[])
  ]);
  const uses = (...html: Array<string | null | undefined>) => html.some(part => (part || "").includes(url));
  return [
    ...(mail || []).filter(t => !t.is_default && uses(t.front_html, t.back_html, t.html_content)).map(t => `${t.type} "${t.name}" (template_id: ${t.id})`),
    ...(messages || []).filter(t => uses(t.html_content, t.body)).map(t => `email "${t.template_name}" (template_id: ${t.id})`)
  ];
}

export function registerImageTools({ server, spur }: ToolContext) {
  const listImages = (limit: number, signal: AbortSignal) => spur.data<Asset[]>("GET", "/assets", { query: { limit }, signal }).then(r => r || []);

  server.registerTool(
    "spur_list_images",
    {
      title: "List images",
      description: `The user's saved images (logos, headshots, property photos) with their public URLs, newest first. ${USAGE} To add one, use spur_upload_image (from the user's device) or spur_save_image (from a URL).`,
      inputSchema: z.strictObject({ limit: z.number().int().min(1).max(100).default(30).describe("Maximum images to return") }),
      annotations: READ_ONLY
    },
    async ({ limit }, ctx) => {
      const assets = await listImages(limit, ctx.mcpReq.signal);
      if (!assets.length) return textResult("No saved images yet. Ask the user to upload one with spur_upload_image, or save one from a URL with spur_save_image.");
      const text = [
        `# ${assets.length} saved images`,
        ...assets.map(a => `- **${a.filename}** (image_id: ${a.id}; ${[a.mime_type?.replace("image/", ""), kb(a.size_bytes), date(a.created_at)].filter(Boolean).join(", ")}): ${a.public_url}`),
        "",
        USAGE
      ].join("\n");
      return structuredResult(text, { images: assets.map(assetSummary) });
    }
  );

  server.registerTool(
    "spur_save_image",
    {
      title: "Save image from URL",
      description: `Download an image from a public https URL (the user's website, a shared photo link) and save it to the user's Spur image library, so it stays available for printing and sending. Returns the saved image's URL. JPG, PNG, WebP, GIF or SVG, up to 20 MB. For a file on the user's device, use spur_upload_image instead. Only save images the user provided or asked for.`,
      inputSchema: z.strictObject({
        url: z.string().url().max(4096).describe("Public https URL of the image"),
        filename: z.string().max(120).optional().describe("Name to save it under, e.g. 'acme-logo'")
      }),
      annotations: { ...WRITE, openWorldHint: true }
    },
    async ({ url, filename }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const image = await fetchRemoteImage(url, MAX_IMAGE_BYTES, URL_FETCH_TIMEOUT_MS);
      if (!image) {
        return {
          ...textResult(
            "Couldn't download an image from that URL. It must be a public https link straight to a JPG, PNG, WebP, GIF or SVG file (not a web page or a sign-in-only share link), up to 20 MB. If the image is on the user's device, use spur_upload_image."
          ),
          isError: true
        };
      }
      const fromUrl = new URL(url).pathname.split("/").pop();
      const saved = await saveImage(spur, image.body, filename || (fromUrl ? decodeURIComponent(fromUrl) : undefined), signal);
      if ("error" in saved) return { ...textResult(saved.error), isError: true };
      return structuredResult(savedText(saved, `Saved **${saved.filename}** to the user's image library (image_id: ${saved.id}).`), { image: assetSummary(saved) });
    }
  );

  registerAppTool(
    server,
    "spur_upload_image",
    {
      title: "Upload image",
      description: `Show an upload box where the user picks or drops an image from their device (logo, headshot, property photo); it's saved to their Spur image library. Use this whenever the user wants to use their own image, including one they attached to the chat: attachments don't reach Spur, so ask them to drop it into the box. After uploading, the user can click "Use this image", or call spur_list_images to get the URL.`,
      inputSchema: z.strictObject({
        purpose: z.string().max(120).optional().describe("What the image is for, shown to the user, e.g. 'Logo for the postcard back'")
      }),
      annotations: READ_ONLY,
      _meta: widgetMeta(IMAGE_UPLOAD_URI, "Opening uploader…", "Upload ready")
    },
    async ({ purpose }) =>
      structuredResult(
        `Upload box shown${purpose ? ` for: ${purpose}` : ""}. Wait for the user to upload; the widget saves the image and reports its URL. Don't ask for the image any other way.`,
        { view: "image-upload", purpose: purpose || null, max_bytes: MAX_UPLOAD_BYTES }
      )
  );

  registerAppTool(
    server,
    "spur_save_uploaded_image",
    {
      title: "Save uploaded image",
      description: "Used by the upload widget to save the file the user picked. Not for the assistant.",
      inputSchema: z.strictObject({
        filename: z.string().max(255).describe("Original file name"),
        data_base64: z
          .string()
          .min(8)
          .max(Math.ceil((MAX_UPLOAD_BYTES * 4) / 3) + 4)
          .describe("File contents, base64-encoded")
      }),
      annotations: WRITE,
      _meta: { ui: { resourceUri: IMAGE_UPLOAD_URI, visibility: ["app"] } }
    },
    async ({ filename, data_base64 }, ctx) => {
      const body = Buffer.from(data_base64, "base64");
      if (body.length > MAX_UPLOAD_BYTES) return { ...textResult("That file is too large to upload here (3 MB after resizing)."), isError: true };
      const saved = await saveImage(spur, body, filename, ctx.mcpReq.signal);
      if ("error" in saved) return { ...textResult(saved.error), isError: true };
      return structuredResult(savedText(saved, `Saved **${saved.filename}** to the user's image library (image_id: ${saved.id}).`), { image: assetSummary(saved) });
    }
  );

  server.registerTool(
    "spur_delete_image",
    {
      title: "Delete image",
      description:
        "Permanently delete one of the user's saved images. Refused while one of their postcard, letter or email templates still uses it, since those would show a broken image. Confirm with the user first.",
      inputSchema: z.strictObject({ image_id: uuid("Image").describe("image_id from spur_list_images"), confirm: confirmField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ image_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const asset = (await listImages(100, signal)).find(a => a.id === image_id);
      if (!asset) return { ...textResult(`Image ${image_id} not found. Call spur_list_images.`), isError: true };
      const using = await templatesUsing(spur, asset.public_url, signal);
      if (using.length) {
        return {
          ...textResult(`Not deleted: ${using.join(", ")} still use${using.length === 1 ? "s" : ""} "${asset.filename}". Swap the image out of ${using.length === 1 ? "it" : "them"} first, then delete.`),
          isError: true
        };
      }
      await spur.request("DELETE", `/assets/${encodeURIComponent(image_id)}`, { signal });
      return textResult(`Deleted image "${asset.filename}".`);
    }
  );
}
