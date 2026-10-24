/**
 * Direct-mail helpers shared by the postcard and letter tools: template loading (the user's own,
 * Spur defaults and the built-in gallery), merge data, previews, blank starters and cost estimates.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { inlineImages } from "../inlineImages.js";
import { messageArea } from "../postcardZones.js";
import { SpurApiError, type SpurClient } from "../spurApi.js";
import { POSTCARD_ARTWORK_META } from "../widgets.js";

export type MailType = "postcard" | "letter";

export const MAX_RECIPIENTS = 1000;
export const LAUNCH_TOKEN_TTL_SECONDS = 30 * 60;

/** Appended to preview results: ChatGPT otherwise pads previews with lookalike web images */
export const PREVIEW_GUIDANCE =
  "The widget above shows the actual rendered mail piece; it is the only preview. Do not search the web or show other images, mockups or similar templates, and do not describe design details beyond what's listed here.";

export const POSTCARD_SIZES = ["6x4", "6x9", "6x11"] as const;
export type PostcardSize = (typeof POSTCARD_SIZES)[number];
/** Trim size in inches, landscape (width × height) */
export const SIZE_INCHES: Record<PostcardSize, [number, number]> = { "6x4": [6, 4], "6x9": [9, 6], "6x11": [11, 6] };
export const normalizeSize = (value: unknown): PostcardSize => (POSTCARD_SIZES.includes(value as PostcardSize) ? (value as PostcardSize) : "6x4");

/** The two letter formats Spur mails; the backend stores them as a template tag */
export const LETTER_TYPES = ["top_first_page", "insert_blank_page"] as const;
export type LetterType = (typeof LETTER_TYPES)[number];
export const LETTER_TYPE_TAGS: Record<LetterType, string> = { top_first_page: "Top First Page", insert_blank_page: "Insert Blank Page" };
export const LETTER_TYPE_SUMMARY: Record<LetterType, string> = {
  top_first_page: "address prints in the top 3.15in of page 1 and shows through a #10 window envelope",
  insert_blank_page: "Spur adds a separate address page in front, so the letter keeps a full-page design (one extra page is billed)"
};

export interface Template {
  id: string;
  user_id?: string | null;
  name: string;
  description?: string | null;
  type: MailType;
  category?: string | null;
  front_html?: string | null;
  back_html?: string | null;
  html_content?: string | null;
  size?: string | null;
  letter_template_tag?: string | null;
  metadata?: Record<string, unknown> | null;
  is_default?: boolean;
  /** Set by loadTemplate: "gallery" templates live in Spur's built-in library and must be copied before mailing */
  source?: "yours" | "default" | "gallery";
  updated_at?: string;
  created_at?: string;
}

export interface ReturnAddress {
  id: string;
  name: string;
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  postal_code: string;
  phone?: string | null;
  email?: string | null;
  is_default?: boolean;
}

export interface Owner {
  id: string;
  full_name?: string | null;
  mailing_address?: string | null;
}

interface BillingMetric {
  label?: string;
  unitPriceMicros?: number;
  remaining?: number | null;
  includedMonthly?: number | null;
  used?: number;
}

interface PlanFeature {
  unitPriceMicros?: number;
  variantPrices?: Record<string, { unitPriceMicros?: number }> | null;
  additionalUnitPriceMicros?: number | null;
}

export interface BillingSummary {
  wallet?: { balanceUsd?: number };
  metrics?: Record<string, BillingMetric> | BillingMetric[];
  plan?: { features?: Record<string, PlanFeature> };
  autoBillEligible?: boolean;
}

/** Placeholder data so a template preview looks real even before recipients are chosen */
const SAMPLE_MERGE_DATA: Record<string, string> = {
  owner_first_name: "Jordan",
  owner_last_name: "Rivera",
  owner_full_name: "Jordan Rivera",
  recipient_first_name: "Jordan",
  recipient_last_name: "Rivera",
  recipient_full_name: "Jordan Rivera",
  property_address: "1428 Elm Street",
  property_city: "Austin",
  property_state: "TX",
  property_zip: "78704",
  property_bedrooms: "3",
  property_bathrooms: "2",
  property_sqft: "1,640",
  property_amount: "$2,350",
  ai_personalized_intro: "I noticed your home on Elm Street and wanted to reach out personally.",
  qr_code_url: "",
  qr_code_image_url: ""
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringifyValues(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === null || value === undefined || typeof value === "object") continue;
    out[key] = String(value);
  }
  return out;
}

export function senderMergeData(address: ReturnAddress | undefined): Record<string, string> {
  if (!address) return {};
  return stringifyValues({
    sender_address: address.address_line1,
    sender_city: address.city,
    sender_state: address.state,
    sender_zip: address.postal_code,
    sender_phone: address.phone,
    sender_email: address.email,
    sender_company: address.company_name
  });
}

export function formatAddress(a: ReturnAddress): string {
  return [a.company_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || a.name, a.address_line1, a.address_line2, `${a.city}, ${a.state} ${a.postal_code}`]
    .filter(Boolean)
    .join(", ");
}

/** Lists any {{merge_fields}} a template uses so the model can tell the user what gets filled in */
export function mergeFieldsIn(...html: Array<string | null | undefined>): string[] {
  const found = new Set<string>();
  for (const part of html) for (const match of (part || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) found.add(match[1] as string);
  return [...found].sort();
}

/** Letter format from the template tag/metadata, mirroring the backend's inference */
export function letterTypeOf(template: Pick<Template, "letter_template_tag" | "metadata">): LetterType {
  const meta = template.metadata || {};
  const tag = String(template.letter_template_tag || meta.letter_template_tag || "").trim().toLowerCase();
  if (tag === "insert blank page" || tag === "inserts blank page") return "insert_blank_page";
  if (tag === "top first page") return "top_first_page";
  return meta.address_placement === "insert_blank_page" ? "insert_blank_page" : "top_first_page";
}

export function sourceLabel(t: Template): string {
  if (t.source === "gallery") return "Spur gallery (copy to edit or mail)";
  return t.is_default ? "Spur default (copy to edit)" : "yours";
}

// ---------------------------------------------------------------- blank starters

const POSTCARD_PX_PER_IN = 300;
const BLEED_IN = 0.125;

/**
 * Empty, correctly sized artwork for a new postcard. The back's message column stops short of the
 * address block, postage and USPS barcode zones Spur reserves on the right.
 */
export function blankPostcard(size: PostcardSize): { front_html: string; back_html: string } {
  const [trimW, trimH] = SIZE_INCHES[size];
  const bleedW = trimW + BLEED_IN * 2;
  const bleedH = trimH + BLEED_IN * 2;
  const w = Math.round(bleedW * POSTCARD_PX_PER_IN);
  const h = Math.round(bleedH * POSTCARD_PX_PER_IN);
  const safe = Math.round(BLEED_IN * 2 * POSTCARD_PX_PER_IN);
  const message = messageArea(size);
  const px = (inches: number) => Math.round(inches * POSTCARD_PX_PER_IN);
  const doc = (side: string, body: string, extraCss = "") => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${side}</title>
<style>
  @page { size: ${bleedW}in ${bleedH}in; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; width: ${w}px; height: ${h}px; overflow: hidden; background: #ffffff; }
  .postcard { position: relative; width: ${w}px; height: ${h}px; background: #ffffff; font-family: Arial, Helvetica, sans-serif; color: #1f2937; }
  /* Text stays inside the safe area: 0.125in bleed + 0.125in margin on every edge */
  .safe { position: absolute; inset: ${safe}px; }${extraCss}
</style>
</head>
<body>
<div class="postcard">${body}</div>
</body>
</html>`;
  return {
    front_html: doc("Front", `\n  <div class="safe"></div>\n`),
    back_html: doc(
      "Back",
      `\n  <div class="message"></div>\n  <!-- USPS clear zone: keep everything right of and below .message empty. Spur prints postage (top right), the address block and the USPS barcode strip (bottom right) there and covers anything underneath -->\n`,
      `\n  .message { position: absolute; left: ${px(message.x)}px; top: ${px(message.y)}px; width: ${px(message.w)}px; height: ${px(message.h)}px; }`
    )
  };
}

/** Empty one-page US Letter in the layout each letter format needs */
export function blankLetter(letterType: LetterType): string {
  const top =
    letterType === "top_first_page"
      ? `  <!-- Keep blank: Spur prints the return and recipient addresses here (shows through a #10 window envelope) -->\n  <div class="address-zone"></div>`
      : `  <div class="letterhead"></div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Letter</title>
<style>
  @page { size: 8.5in 11in; margin: 0; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0; padding: 0; background: #ffffff; }
  .letter { position: relative; width: 8.5in; min-height: 11in; margin: 0 auto; background: #ffffff; display: flex; flex-direction: column; page-break-inside: avoid; break-inside: avoid; font-family: Georgia, "Times New Roman", serif; color: #1f2937; }
  .address-zone { height: 3.15in; flex-shrink: 0; }
  .letterhead { padding: 0.5in 0.75in 0.3in; flex-shrink: 0; }
  .letter-body { padding: 0 0.75in; flex: 1; font-size: 13px; line-height: 1.55; }
  .letter-body p { margin: 0 0 16px; }
  .signature { margin-top: 24px; }
  .letter-footer { padding: 0 0.75in 0.4in; font-size: 11px; color: #6b7280; }
</style>
</head>
<body>
<div class="letter">
${top}
  <div class="letter-body">
    <p>Dear {{owner_first_name}},</p>
    <p></p>
    <div class="signature">
      <p>Sincerely,</p>
      <p>{{your_name}}<br>{{company_name}} · {{your_phone}}</p>
    </div>
  </div>
  <div class="letter-footer"></div>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------- Spur access

interface GalleryTemplate {
  id: string;
  name: string;
  type: MailType;
  category?: string | null;
  html_content?: string | null;
  front_html?: string | null;
  back_html?: string | null;
  size?: string | null;
  letter_template_tag?: string | null;
  metadata?: Record<string, unknown> | null;
}

const fromGallery = (g: GalleryTemplate): Template => ({
  id: g.id,
  name: g.name,
  type: g.type,
  category: g.category,
  html_content: g.type === "letter" ? g.html_content : null,
  front_html: g.front_html,
  back_html: g.back_html,
  size: g.size,
  letter_template_tag: g.letter_template_tag,
  metadata: g.metadata,
  is_default: true,
  source: "gallery"
});

export function createMailHelpers(spur: SpurClient) {
  const fromSaved = (t: Template): Template => ({ ...t, source: t.is_default ? "default" : "yours" });

  /**
   * Saved templates have UUIDs; anything else is tried as a built-in gallery id first
   * (e.g. "6x4__just_sold", "letter-02-expired-listing").
   */
  const loadTemplate = async (id: string, type: MailType, signal: AbortSignal): Promise<Template> => {
    const saved = () => spur.data<Template>("GET", `/direct-mail/templates/${encodeURIComponent(id)}`, { signal }).then(fromSaved);
    const template = UUID_RE.test(id)
      ? await saved()
      : await spur
          .data<GalleryTemplate>("GET", `/letter-templates/${encodeURIComponent(id)}`, { query: { type }, signal })
          .then(fromGallery)
          .catch(error => {
            if (error instanceof SpurApiError && error.status === 404) return saved();
            throw error;
          });
    if (template.type !== type) throw new Error(`Template ${id} is a ${template.type}, not a ${type}.`);
    return template;
  };

  /** The user's templates and Spur defaults, then the built-in gallery (best effort) */
  const listTemplates = async (type: MailType, category: string | undefined, includeGallery: boolean, signal: AbortSignal) => {
    const [saved, gallery] = await Promise.all([
      spur.data<Template[]>("GET", "/direct-mail/templates", { query: { type, category }, signal }).then(r => (r || []).map(fromSaved)),
      includeGallery
        ? spur
            .data<GalleryTemplate[]>("GET", "/letter-templates", { query: { type }, signal })
            .then(r => (r || []).filter(g => g.type === type && (!category || g.category === category)).map(fromGallery))
            .catch(() => [] as Template[])
        : Promise.resolve([] as Template[])
    ]);
    return { mine: saved.filter(t => !t.is_default), defaults: saved.filter(t => t.is_default), gallery };
  };

  const getReturnAddresses = (signal: AbortSignal) => spur.data<ReturnAddress[]>("GET", "/direct-mail/return-addresses", { signal }).then(r => r || []);

  /** Merge data the backend would use for this owner: owner/property fields plus the user's profile */
  const mergeDataFor = async (ownerId: string | undefined, signal: AbortSignal): Promise<Record<string, string>> => {
    const built = await spur
      .data<Record<string, unknown>>("POST", "/communication/template-data/build", { body: { owner_id: ownerId }, signal })
      .catch(() => ({}));
    const data = stringifyValues(built);
    const full = data.owner_full_name || data.owner_name || "";
    if (ownerId && full && !data.owner_first_name) data.owner_first_name = full.split(/\s+/)[0] || "";
    return ownerId ? data : { ...SAMPLE_MERGE_DATA, ...data };
  };

  /** Sample data plus the default return address, for previews before recipients are chosen */
  const sampleMergeData = async (signal: AbortSignal) => {
    const addresses = await getReturnAddresses(signal).catch(() => [] as ReturnAddress[]);
    return { ...(await mergeDataFor(undefined, signal)), ...senderMergeData(addresses.find(a => a.is_default) || addresses[0]) };
  };

  const renderPostcard = async (template: Pick<Template, "front_html" | "back_html">, mergeVariables: Record<string, string>, signal: AbortSignal) => {
    const rendered = await spur.data<{ front_html: string; back_html: string }>("POST", "/direct-mail/preview", {
      body: { type: "postcard", front_html: template.front_html || "", back_html: template.back_html || "", merge_variables: mergeVariables },
      signal
    });
    return { front: rendered.front_html, back: rendered.back_html };
  };

  /** The backend applies the same print normalisation (address safe area for top_first_page) it mails with */
  const renderLetter = async (html: string, letterType: LetterType, mergeVariables: Record<string, string>, signal: AbortSignal) => {
    const rendered = await spur.data<{ html: string }>("POST", "/direct-mail/preview", {
      body: { type: "letter", html_content: html, merge_variables: mergeVariables, address_placement: letterType },
      signal
    });
    return rendered.html;
  };

  /**
   * Recipients split into mailable / no address / unknown, plus the return address to mail from.
   * Returns an error message instead when nothing can be mailed.
   */
  const resolveCampaign = async (ownerIdsIn: string[], returnAddressId: string | undefined, signal: AbortSignal) => {
    const ownerIds = [...new Set(ownerIdsIn)];
    const [addresses, owners, billing] = await Promise.all([
      getReturnAddresses(signal),
      spur.data<Owner[]>("GET", "/owners", { signal }).then(o => o || []),
      spur.data<BillingSummary>("GET", "/billing/summary", { signal }).catch(() => ({}) as BillingSummary)
    ]);
    const returnAddress = returnAddressId ? addresses.find(a => a.id === returnAddressId) : addresses.find(a => a.is_default) || addresses[0];
    if (!returnAddress) {
      return {
        error: returnAddressId
          ? `Return address ${returnAddressId} not found. Call spur_list_return_addresses.`
          : "No return address on file. Add one in Spur → Direct Mail → Return addresses, then preview again."
      } as const;
    }
    const byId = new Map(owners.map(o => [o.id, o]));
    const unknown = ownerIds.filter(id => !byId.has(id));
    const noAddress = ownerIds.filter(id => byId.has(id) && !byId.get(id)?.mailing_address?.trim());
    const mailable = ownerIds.filter(id => byId.get(id)?.mailing_address?.trim());
    if (!mailable.length) {
      return { error: `None of the ${ownerIds.length} owners have a mailing address on file. Run spur_enrich on them first.` } as const;
    }
    return { ownerIds, returnAddress, unknown, noAddress, mailable, sampleOwner: byId.get(mailable[0] as string) as Owner, billing } as const;
  };

  return { loadTemplate, listTemplates, getReturnAddresses, mergeDataFor, sampleMergeData, renderPostcard, renderLetter, resolveCampaign };
}

/**
 * Plan-included pieces first, then the per-piece price. The plan's size variant (postcards) and
 * per-extra-page price (letters) are applied the way the backend bills them.
 */
export function estimateCost(billing: BillingSummary, metricKey: MailType, count: number, options: { variantKey?: string; additionalUnits?: number } = {}) {
  const metrics = Array.isArray(billing.metrics) ? undefined : billing.metrics;
  const metric = metrics?.[metricKey];
  const feature = billing.plan?.features?.[metricKey];
  const variantMicros = options.variantKey ? feature?.variantPrices?.[options.variantKey]?.unitPriceMicros : undefined;
  const baseMicros = variantMicros ?? feature?.unitPriceMicros ?? metric?.unitPriceMicros;
  const unitMicros = baseMicros === undefined ? undefined : baseMicros + (options.additionalUnits || 0) * Number(feature?.additionalUnitPriceMicros || 0);
  const unitUsd = unitMicros ? unitMicros / 1_000_000 : undefined;
  const included = metric?.remaining === null ? Infinity : Math.max(0, Number(metric?.remaining ?? 0));
  const billable = Math.max(0, count - (Number.isFinite(included) ? included : count));
  const estimate = unitUsd !== undefined ? billable * unitUsd : undefined;
  const walletUsd = billing.wallet?.balanceUsd;
  const walletShort = estimate !== undefined && walletUsd !== undefined && !billing.autoBillEligible && estimate > walletUsd;
  const covered = Number.isFinite(included) ? Math.min(included, count) : count;
  return {
    summary:
      estimate !== undefined ? `$${estimate.toFixed(2)} (${billable} × $${unitUsd?.toFixed(2)}; ${covered} covered by plan)` : "see Spur billing",
    cost: {
      recipients: count,
      included_remaining: Number.isFinite(included) ? included : null,
      billable,
      unit_price_usd: unitUsd ?? null,
      estimated_charge_usd: estimate ?? null,
      wallet_balance_usd: walletUsd ?? null,
      wallet_short: walletShort
    }
  };
}

/**
 * The widget gets the artwork with images inlined via `_meta` (widget-only on ChatGPT), keeping the
 * multi-megabyte data: URIs out of structuredContent, which the model reads.
 */
export async function withWidgetArtwork(result: CallToolResult, html: { front?: string; back?: string; letter?: string }): Promise<CallToolResult> {
  const artwork =
    html.letter !== undefined
      ? { html: await inlineImages(html.letter) }
      : await Promise.all([inlineImages(html.front || ""), inlineImages(html.back || "")]).then(([front_html, back_html]) => ({ front_html, back_html }));
  return { ...result, _meta: { [POSTCARD_ARTWORK_META]: artwork } };
}
