/**
 * USPS clear-zone check for a postcard back. Renders the back in a hidden frame at its natural size,
 * maps design pixels onto the printed bleed box the way the backend does (contain-scale, centered),
 * and reports visible text and images that land inside a zone. Background colors and full-card art
 * are ignored: Spur prints white over the zone, so they're fine there.
 */

export interface Zone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClearZoneSpec {
  bleed_inches: [number, number];
  zones: Zone[];
  message_area?: Box;
}

export interface Overlap {
  zone: Zone;
  what: string;
  /** Inches on the bleed box */
  box: Box;
}

export interface ZoneCheck {
  status: "clear" | "overlap" | "unavailable";
  overlaps: Overlap[];
  /** The design canvas in document px (what the backend scales onto the bleed box) */
  canvas?: { left: number; top: number; w: number; h: number };
}

/** Design px → bleed inches, mirroring normalizePostcardHtmlForSize's contain-scale */
export function designToBleed(designW: number, designH: number, bleed: [number, number]) {
  const s = Math.min(bleed[0] / designW, bleed[1] / designH);
  return { s, ox: (bleed[0] - designW * s) / 2, oy: (bleed[1] - designH * s) / 2 };
}

/** Same order as POSTCARD_ROOT_SELECTORS in backend/src/utils/postcardUtils.js */
const ROOT_SELECTORS = ["[data-postcard-canvas]", ".postcard", ".mailer", ".card", ".sheet", ".page"];

/** The element the backend treats as the design canvas, else the body */
function canvasOf(doc: Document): NonNullable<ZoneCheck["canvas"]> {
  for (const selector of ROOT_SELECTORS) {
    const rect = doc.body.querySelector(selector)?.getBoundingClientRect();
    if (rect && rect.width > 100 && rect.height > 60) return { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
  }
  const body = doc.body.getBoundingClientRect();
  return { left: body.left, top: body.top, w: Math.max(body.width, 1), h: Math.max(body.height, doc.body.scrollHeight, 1) };
}

const MEDIA = new Set(["img", "svg", "canvas", "video", "picture", "object", "embed", "iframe"]);
const MIN_OVERLAP_IN = 0.02;
const MAX_ELEMENTS = 5000;

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > MIN_OVERLAP_IN && h > MIN_OVERLAP_IN ? { x, y, w, h } : null;
}

function describeElement(node: Element): string {
  const tag = node.tagName.toLowerCase();
  if (node.hasAttribute("data-spur-qr-merge")) return "QR code";
  if (tag === "img") {
    const alt = node.getAttribute("alt")?.trim();
    if (alt) return `image "${alt.slice(0, 40)}"`;
    const src = node.getAttribute("src") || "";
    if (src.startsWith("data:")) return "embedded image";
    const file = src.split(/[?#]/)[0]?.split("/").pop();
    return file ? `image ${file.slice(0, 40)}` : "image";
  }
  const cls = typeof node.className === "string" && node.className.trim() ? `.${node.className.trim().split(/\s+/)[0]}` : "";
  return `<${tag}${cls}>`;
}

function measure(doc: Document, spec: ClearZoneSpec): ZoneCheck {
  const view = doc.defaultView;
  if (!view || !doc.body) return { status: "unavailable", overlaps: [] };
  const canvas = canvasOf(doc);
  const map = designToBleed(canvas.w, canvas.h, spec.bleed_inches);
  const toIn = (r: DOMRect): Box => ({ x: map.ox + (r.left - canvas.left) * map.s, y: map.oy + (r.top - canvas.top) * map.s, w: r.width * map.s, h: r.height * map.s });
  const cardArea = spec.bleed_inches[0] * spec.bleed_inches[1];
  const hidden = (el: Element) => {
    const style = view.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
  };
  /** Something unrelated painted on top (e.g. the template's own white box) means it isn't visible there */
  const covered = (el: Element, box: Box) => {
    const top = doc.elementFromPoint(canvas.left + (box.x + box.w / 2 - map.ox) / map.s, canvas.top + (box.y + box.h / 2 - map.oy) / map.s);
    return !!top && top !== el && !el.contains(top) && !top.contains(el);
  };

  const items: Array<{ el: Element; what: string; box: Box }> = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent || "").replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (!text || !parent || hidden(parent)) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0.5 && rect.height > 0.5) items.push({ el: parent, what: `text "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`, box: toIn(rect) });
    }
  }
  const elements = Array.from(doc.body.querySelectorAll("*")).slice(0, MAX_ELEMENTS);
  for (const node of elements) {
    const tag = node.tagName.toLowerCase();
    const outerSvg = node.parentElement?.closest("svg");
    if (outerSvg) continue;
    const isMedia = MEDIA.has(tag);
    const style = view.getComputedStyle(node);
    const hasImage = !isMedia && style.backgroundImage !== "none" && /url\(/.test(style.backgroundImage);
    if ((!isMedia && !hasImage) || hidden(node)) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    const box = toIn(rect);
    // Full-card or panel-sized art under a zone just gets printed over in white
    if (box.w * box.h > cardArea * 0.4) continue;
    items.push({ el: node, what: hasImage ? `background image on ${describeElement(node)}` : describeElement(node), box });
  }

  const seen = new Set<string>();
  const overlaps: Overlap[] = [];
  for (const zone of spec.zones) {
    for (const item of items) {
      const hit = intersect(item.box, zone);
      if (!hit || covered(item.el, hit)) continue;
      const key = `${zone.id}|${item.what}`;
      if (seen.has(key)) continue;
      seen.add(key);
      overlaps.push({ zone, what: item.what, box: item.box });
    }
  }
  return { status: overlaps.length ? "overlap" : "clear", overlaps, canvas };
}

const nextFrame = (win: Window) => new Promise<void>(resolve => win.requestAnimationFrame(() => resolve()));

export function checkClearZone(html: string, spec: ClearZoneSpec, guessPx: [number, number], timeoutMs = 6000): Promise<ZoneCheck> {
  return new Promise(resolve => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.tabIndex = -1;
    frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${guessPx[0]}px;height:${guessPx[1]}px;border:0;opacity:0;pointer-events:none;`;
    let done = false;
    const finish = (result: ZoneCheck) => {
      if (done) return;
      done = true;
      frame.remove();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "unavailable", overlaps: [] }), timeoutMs);
    frame.addEventListener("load", async () => {
      try {
        const doc = frame.contentDocument;
        if (!doc?.documentElement) return finish({ status: "unavailable", overlaps: [] });
        // Size the frame to the design so nothing reflows to the guess
        const w = doc.documentElement.scrollWidth;
        const h = doc.documentElement.scrollHeight;
        if (w > 200 && h > 120 && Math.abs(w / h - guessPx[0] / guessPx[1]) < 0.35) {
          frame.style.width = `${w}px`;
          frame.style.height = `${h}px`;
        }
        await Promise.race([doc.fonts?.ready, new Promise(r => setTimeout(r, 2000))]);
        await nextFrame(window);
        clearTimeout(timer);
        finish(measure(doc, spec));
      } catch {
        finish({ status: "unavailable", overlaps: [] });
      }
    });
    frame.srcdoc = html;
    document.body.append(frame);
  });
}

/** Plain-language report for the assistant, naming each item and where it can go instead */
export function describeCheck(check: ZoneCheck, name: string, spec: ClearZoneSpec): string {
  if (check.status === "unavailable") return "";
  if (check.status === "clear") return `Clear-zone check: the back of "${name}" keeps the USPS clear zone (postage, address block, barcode strip) empty.`;
  const lines = check.overlaps.map(o => `- ${o.zone.label}: ${o.what}`);
  const area = spec.message_area;
  const where = area ? ` Move it into the message area (x ${area.x.toFixed(2)}–${(area.x + area.w).toFixed(2)}in, y ${area.y.toFixed(2)}–${(area.y + area.h).toFixed(2)}in from the bleed's top-left)` : " Move it out of the zone";
  return [`Clear-zone check: the back of "${name}" has content inside the USPS clear zone, which Spur covers with white when printing:`, ...lines, `${where} with spur_update_postcard_template, then preview again.`].join("\n");
}
