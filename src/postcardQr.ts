/**
 * Per-recipient QR placeholders on a postcard back, written exactly the way Spur's editor writes
 * them (GrapesEditorSimple insertQrMergeVariable): an <img src="{{qrUrl}}"> tagged with the parent
 * QR code's id. When a postcard is mailed, the backend reads data-spur-parent-qr-id, mints one
 * tracked code per recipient under that parent and fills {{qrUrl}} with its image.
 *
 * Placement: the template's own QR slot (.qr-box and friends, as the editor looks for), else an
 * absolutely positioned square inside the back's message area, which clears every USPS zone.
 * String-based on purpose: the MCP has no DOM, and templates are small, well-formed documents.
 */
import { bleedInches, clearZones, messageArea, POSTCARD_BLEED_IN, type ZoneSize } from "./postcardZones.js";

export interface QrCode {
  id: string;
  name: string;
  destination_url?: string | null;
  public_token?: string | null;
  foreground_color?: string | null;
  background_color?: string | null;
  image_url?: string | null;
  redirect_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export const QR_POSITIONS = ["auto", "top_left", "top_right", "bottom_left", "bottom_right"] as const;
export type QrPosition = (typeof QR_POSITIONS)[number];

/** Same targets as the editor's QR_PLACEMENT_SELECTORS, innermost frame first */
const SLOT_CLASSES = ["qr-callout-box-inner", "qr-callout-box", "qr-box", "qr-code-box", "qr-placeholder", "qr-image-placeholder"];
const SLOT_ATTRS = ["data-spur-qr-box", "data-spur-qr-placeholder", "data-qr-box", "data-qr-placeholder"];
/** Same order as POSTCARD_ROOT_SELECTORS in backend/src/utils/postcardUtils.js */
const ROOT_CLASSES = ["postcard", "mailer", "card", "sheet", "page"];

const WRAP_ATTR = "data-spur-qr-wrap";
const STYLE_ATTR = "data-spur-qr-style";
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

interface Found {
  tag: string;
  attrs: string;
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
}

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attrValue = (attrs: string, name: string) => new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`, "i").exec(attrs)?.[2];
const hasAttr = (attrs: string, name: string) => new RegExp(`\\s${name}(\\s*=|[\\s/>]|$)`, "i").test(attrs);
const classes = (attrs: string) => (attrValue(attrs, "class") || "").split(/\s+/).filter(Boolean);

/** Comments, <style> and <script> blanked out (same length) so tag scans can't match inside them */
const masked = (html: string) => html.replace(/<!--[\s\S]*?-->|<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, m => " ".repeat(m.length));

/** First element whose open tag matches, with its matching close tag */
function findElement(html: string, match: (tag: string, attrs: string) => boolean): Found | undefined {
  const text = masked(html);
  const open = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const tag = (m[1] as string).toLowerCase();
    const attrs = m[2] as string;
    if (VOID_TAGS.has(tag) || attrs.endsWith("/") || !match(tag, attrs)) continue;
    const openEnd = m.index + m[0].length;
    const nested = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    nested.lastIndex = openEnd;
    let depth = 1;
    for (let n = nested.exec(text); n; n = nested.exec(text)) {
      depth += n[1] ? -1 : 1;
      if (depth === 0) return { tag, attrs, start: m.index, openEnd, closeStart: n.index, end: n.index + n[0].length };
    }
    return undefined;
  }
  return undefined;
}

const QR_IMG = /<img\b[^>]*\sdata-spur-qr-merge\s*=\s*(["'])true\1[^>]*>/gi;

/** Parent QR code ids referenced by placeholders on either side */
export function qrParentIds(...html: Array<string | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const part of html) for (const m of (part || "").matchAll(/\sdata-spur-parent-qr-id\s*=\s*(["'])([^"']+)\1/gi)) ids.add((m[2] as string).trim());
  return [...ids];
}

/** True when the HTML prints a per-recipient QR ({{qrUrl}} or a merge image) */
export function hasQrPlaceholder(html: string | null | undefined): boolean {
  return /data-spur-qr-merge\s*=\s*["']true["']|\{\{\s*(qrUrl|qr_image_url|qrImageUrl)\s*\}\}/i.test(html || "");
}

/** True when the HTML has a QR slot (.qr-box and friends) that spur_add_postcard_qr_code would fill */
export function hasQrSlot(html: string | null | undefined): boolean {
  const source = html || "";
  return (
    SLOT_CLASSES.some(name => findElement(source, (_t, a) => classes(a).includes(name))) || SLOT_ATTRS.some(name => findElement(source, (_t, a) => hasAttr(a, name)))
  );
}

/** Removes every QR placeholder plus the wrapper/style this module added. Returns how many were removed. */
export function removeQrPlaceholders(html: string): { html: string; removed: number } {
  let out = html;
  let removed = 0;
  for (let wrap = findElement(out, (_t, a) => hasAttr(a, WRAP_ATTR)); wrap; wrap = findElement(out, (_t, a) => hasAttr(a, WRAP_ATTR))) {
    out = out.slice(0, wrap.start) + out.slice(wrap.end);
    removed++;
  }
  out = out.replace(QR_IMG, () => {
    removed++;
    return "";
  });
  out = out.replace(new RegExp(`<style\\b[^>]*\\s${STYLE_ATTR}\\b[^>]*>[\\s\\S]*?</style\\s*>\\s*`, "gi"), "");
  return { html: out, removed };
}

function placeholderImg(qr: QrCode, style: string): string {
  const previewSrc = qr.image_url || "";
  return [
    `<img src="{{qrUrl}}"`,
    ` alt="${escapeAttr(`Personalized QR Code (${qr.name})`)}"`,
    ` data-spur-qr-merge="true"`,
    ` data-spur-qr-merge-variable="qrUrl"`,
    previewSrc ? ` data-spur-qr-preview-src="${escapeAttr(previewSrc)}"` : "",
    ` data-spur-parent-qr-id="${escapeAttr(qr.id)}"`,
    ` data-spur-parent-qr-name="${escapeAttr(qr.name)}"`,
    ` style="${style}">`
  ].join("");
}

/** A box in inches from the bleed's top-left */
export interface QrBox {
  x: number;
  y: number;
  size: number;
}

export interface PlaceOptions {
  position: QrPosition;
  /** Edge length in inches when placed in the message area */
  sizeInches: number;
  /** Explicit top-left corner in inches from the bleed's top-left; overrides position */
  at?: { x: number; y: number };
}

export type PlaceResult =
  | { ok: true; html: string; placement: "slot"; slot: string; replaced: number }
  | { ok: true; html: string; placement: "message_area"; box: QrBox; anchored: "canvas" | "page"; replaced: number }
  | { ok: false; error: string };

const round = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${round(v * 100)}%`;

/** Where the QR sits in the message area for a named position, or why an explicit corner doesn't fit */
export function qrBoxFor(size: ZoneSize, options: PlaceOptions): { box: QrBox } | { error: string } {
  const area = messageArea(size);
  const q = options.sizeInches;
  if (q > area.w + 1e-6 || q > area.h + 1e-6) {
    return { error: `A ${q}in QR code doesn't fit the ${size} message area (${round(area.w)}in × ${round(area.h)}in). Use size_inches ≤ ${round(Math.min(area.w, area.h))}.` };
  }
  if (options.at) {
    const box = { x: round(options.at.x), y: round(options.at.y), size: q };
    const [bw, bh] = bleedInches(size);
    const margin = POSTCARD_BLEED_IN * 2;
    if (box.x < margin - 1e-6 || box.y < margin - 1e-6 || box.x + q > bw - margin + 1e-6 || box.y + q > bh - margin + 1e-6) {
      return { error: `That spot runs past the safe margin: keep the QR code ${margin}in inside every edge of the ${bw}in × ${bh}in bleed box.` };
    }
    const hit = clearZones(size).find(z => box.x < z.x + z.w && box.x + q > z.x && box.y < z.y + z.h && box.y + q > z.y);
    if (hit) {
      return {
        error: `That spot overlaps the USPS ${hit.label.toLowerCase()} zone (x ${hit.x}–${round(hit.x + hit.w)}in, y ${hit.y}–${round(hit.y + hit.h)}in), which Spur prints over. Pick a spot in the message area: x ${round(area.x)}–${round(area.x + area.w)}in, y ${round(area.y)}–${round(area.y + area.h)}in.`
      };
    }
    return { box };
  }
  const left = area.x;
  const right = area.x + area.w - q;
  const top = area.y;
  const bottom = area.y + area.h - q;
  const corner = {
    top_left: [left, top],
    top_right: [right, top],
    bottom_left: [left, bottom],
    bottom_right: [right, bottom],
    auto: [right, bottom]
  }[options.position] as [number, number];
  return { box: { x: round(corner[0]), y: round(corner[1]), size: q } };
}

/** The canvas the backend scales onto the bleed box, by the same selector order */
function findRoot(html: string): { found: Found; selector: string } | undefined {
  const byAttr = findElement(html, (_t, a) => hasAttr(a, "data-postcard-canvas"));
  if (byAttr) return { found: byAttr, selector: "[data-postcard-canvas]" };
  for (const name of ROOT_CLASSES) {
    const found = findElement(html, (_t, a) => classes(a).includes(name));
    if (found) return { found, selector: `.${name}` };
  }
  return undefined;
}

/** CSS rules for the root already make it a containing block for the absolutely placed QR */
function rootIsPositioned(html: string, root: { found: Found; selector: string }): boolean {
  if (/position\s*:\s*(relative|absolute|fixed|sticky)/i.test(attrValue(root.found.attrs, "style") || "")) return true;
  const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map(m => m[1]).join("\n");
  const sel = root.selector.replace(/[.[\]]/g, c => `\\${c}`);
  return new RegExp(`(^|[},\\s])${sel}\\s*[,{][^}]*?position\\s*:\\s*(relative|absolute|fixed|sticky)`, "i").test(css);
}

function addStyle(html: string, css: string): string {
  const block = `<style ${STYLE_ATTR}="true">${css}</style>\n`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, m => `${block}${m}`);
  if (/<body\b[^>]*>/i.test(html)) return html.replace(/<body\b[^>]*>/i, m => `${m}\n${block}`);
  return block + html;
}

/**
 * Puts one QR placeholder for `qr` on the back, replacing any placeholder already there (one QR
 * per card: the backend mints codes for a single parent).
 */
export function placeQrPlaceholder(backHtml: string, size: ZoneSize, qr: QrCode, options: PlaceOptions): PlaceResult {
  const { html, removed } = removeQrPlaceholders(backHtml);
  const useSlot = options.position === "auto" && !options.at;

  if (useSlot) {
    for (const name of SLOT_CLASSES) {
      const slot = findElement(html, (_t, a) => classes(a).includes(name));
      if (slot) return fillSlot(html, slot, `.${name}`, qr, removed);
    }
    for (const name of SLOT_ATTRS) {
      const slot = findElement(html, (_t, a) => hasAttr(a, name));
      if (slot) return fillSlot(html, slot, `[${name}]`, qr, removed);
    }
  }

  const placed = qrBoxFor(size, options);
  if ("error" in placed) return { ok: false, error: placed.error };
  const { box } = placed;
  const [bw, bh] = bleedInches(size);
  const background = qr.background_color || "#ffffff";
  // Percentages of the canvas, which the backend contain-scales onto the bleed box
  const wrapStyle = `position:absolute;left:${pct(box.x / bw)};top:${pct(box.y / bh)};width:${pct(box.size / bw)};aspect-ratio:1 / 1;z-index:5;background:${background};`;
  const imgStyle = `display:block;width:100%;height:100%;object-fit:contain;background:${background};border:0;`;
  const wrapper = `<div ${WRAP_ATTR}="true" style="${wrapStyle}">${placeholderImg(qr, imgStyle)}</div>`;

  const root = findRoot(html);
  if (root) {
    let next = html.slice(0, root.found.closeStart) + wrapper + html.slice(root.found.closeStart);
    if (!rootIsPositioned(html, root)) next = addStyle(next, `${root.selector}{position:relative;}`);
    return { ok: true, html: next, placement: "message_area", box, anchored: "canvas", replaced: removed };
  }
  const next = /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, m => `${wrapper}${m}`) : html + wrapper;
  return { ok: true, html: next, placement: "message_area", box, anchored: "page", replaced: removed };
}

function fillSlot(html: string, slot: Found, selector: string, qr: QrCode, replaced: number): PlaceResult {
  // Same as the editor: the image replaces the slot's placeholder content and fills it
  const imgStyle = `display:block;width:100%;height:100%;aspect-ratio:1 / 1;object-fit:contain;background:${qr.background_color || "#ffffff"};border:0;position:relative;z-index:5;`;
  return { ok: true, html: html.slice(0, slot.openEnd) + placeholderImg(qr, imgStyle) + html.slice(slot.closeStart), placement: "slot", slot: selector, replaced };
}
