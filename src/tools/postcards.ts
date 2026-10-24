/**
 * Postcards: template CRUD, previews with real merge data, and the preview → confirm → send flow.
 *
 * Sending is gated twice: spur_send_postcards only accepts a confirmation token minted by
 * spur_preview_postcard_campaign (so the user has seen the artwork, recipients and cost), and the
 * token is sealed and bound to exactly that template, recipient set, return address and size.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { nowSeconds } from "../auth/seal.js";
import { hasQrPlaceholder, hasQrSlot, placeQrPlaceholder, QR_POSITIONS, qrParentIds, removeQrPlaceholders } from "../postcardQr.js";
import { bleedInches, clearZones, describeClearZones, messageArea } from "../postcardZones.js";
import { POSTCARD_PREVIEW_URI, widgetMeta } from "../widgets.js";
import {
  blankPostcard,
  createMailHelpers,
  estimateCost,
  formatAddress,
  LAUNCH_TOKEN_TTL_SECONDS,
  MAX_RECIPIENTS,
  mergeFieldsIn,
  normalizeSize,
  POSTCARD_SIZES,
  PREVIEW_GUIDANCE,
  senderMergeData,
  SIZE_INCHES,
  sourceLabel,
  withWidgetArtwork,
  type PostcardSize,
  type Template
} from "./mail.js";
import { listQrCodes } from "./qrCodes.js";
import { bullets, confirmField, date, OUTWARD, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

interface LaunchToken {
  tid: string;
  oids: string[];
  rid: string;
  size: PostcardSize;
  n: number;
  exp: number;
}

const sizeField = z.enum(POSTCARD_SIZES).describe('Postcard size: "6x4" (standard 4×6), "6x9" or "6x11"');
const templateIdField = z.string().min(1).max(128).describe("Template id from spur_list_postcard_templates (a saved template's UUID or a Spur gallery id)");

const DESIGN_GUIDANCE = `HTML guidance (see spur://postcard-design-guide): full HTML documents, inline <style>, no scripts. Fixed pixel sizing on html, body and a root .postcard at 300 px/in including 0.125" bleed: 6x4 → 1875×1275, 6x9 → 2775×1875, 6x11 → 3375×1875. Keep text 0.25" inside the edge. USPS clear zone on the back, measured from the bleed edges (Spur prints over it and covers anything there): postage 1.25"×1.25" in the top-right corner; address block 3.5"×2", 0.5" from the right edge and 1.35" from the top; USPS barcode strip 4.75"×0.625" along the bottom-right edge. Keep all text, logos, photos and QR codes out of it; a background color or texture under it is fine. The safe message area is left of the address block and above the barcode strip. Images as absolute https URLs. The user's own images (logo, headshot, property photos): spur_list_images gives their URLs; if they want to use an image they have, call spur_upload_image (or spur_save_image for a link) and use the saved URL. Use merge fields such as {{owner_first_name}}, {{property_address}}, {{your_name}}, {{your_phone}}, {{company_name}} (see spur://merge-variables). QR code box by default: unless the user says they don't want a QR code, every back you design includes an empty square <div class="qr-box"> in the message area (≥ 0.75in, e.g. 225×225 px at 300 px/in) with a short call to action beside it ("Scan to see your home's value"). Never write QR markup or {{qrUrl}} yourself: after saving, call spur_add_postcard_qr_code and the tracked QR fills the box (pick the code with spur_list_qr_codes, or ask the user where scans should go and spur_create_qr_code). When resending full back_html, keep the qr-box and any <img data-spur-qr-merge…> inside it, or the QR is dropped.`;

function templateLine(t: Template): string {
  return `- **${t.name}** (template_id: ${t.id}) — ${t.size || "6x4"}${t.category ? `, ${t.category}` : ""}, ${sourceLabel(t)}${t.description ? ` — ${t.description}` : ""}`;
}

export function registerPostcardTools({ server, spur, sealer }: ToolContext) {
  const mail = createMailHelpers(spur);
  const getTemplate = (id: string, signal: AbortSignal) => mail.loadTemplate(id, "postcard", signal);

  const CLEAR_ZONE_CHECK =
  "The widget checks the back's real layout against the USPS clear zone and reports any text or image inside it. If it does, move that content into the message area and preview again; don't mail a design with clear-zone overlaps.";

/** Zones for the widget, which draws them on the back and checks the rendered layout against them */
const clearZonePayload = (size: PostcardSize) => ({ bleed_inches: bleedInches(size), zones: clearZones(size), message_area: messageArea(size) });

  /**
   * The QR the card prints, or why it would print blank / fail at send time: the backend mints
   * per-recipient codes only for a linked parent QR code that still exists.
   */
  const qrStatus = async (template: Template, signal: AbortSignal): Promise<{ label?: string; problem?: string; note?: string }> => {
    if (!hasQrPlaceholder(template.front_html) && !hasQrPlaceholder(template.back_html)) {
      return hasQrSlot(template.back_html)
        ? { label: "empty QR box", note: `The back has a QR code box with no code in it, so it prints empty. Unless the user doesn't want a QR code, link one with spur_add_postcard_qr_code template_id="${template.id}".` }
        : {};
    }
    const fix = `Link one with spur_add_postcard_qr_code template_id="${template.id}" (spur_list_qr_codes lists the user's codes), then preview again.`;
    const ids = qrParentIds(template.front_html, template.back_html);
    if (!ids.length) return { label: "unlinked placeholder", problem: `"${template.name}" has a QR placeholder that isn't linked to a QR code, so it would print blank. ${fix}` };
    const codes = await listQrCodes(spur, signal);
    const linked = ids.map(id => codes.find(c => c.id === id));
    if (linked.some(c => !c)) return { label: "deleted QR code", problem: `"${template.name}" prints a QR code that no longer exists, so mailing it would fail. ${fix}` };
    return { label: linked.map(c => `${c!.name} → ${c!.destination_url} (unique code per recipient)`).join("; ") };
  };

/** Template-only preview used after create/update; recipients and cost come with the campaign preview */
  const templatePreview = async (template: Template, signal: AbortSignal, heading: string, next?: string) => {
    const [html, qr] = await Promise.all([mail.sampleMergeData(signal).then(merge => mail.renderPostcard(template, merge, signal)), qrStatus(template, signal)]);
    const size = normalizeSize(template.size);
    const fields = mergeFieldsIn(template.front_html, template.back_html);
    const text = [
      heading,
      bullets([
        ["Name", template.name],
        ["Size", size],
        ["Source", sourceLabel(template)],
        ["Merge fields", fields.length ? fields.map(f => `{{${f}}}`).join(", ") : "none"],
        ["QR code", qr.label],
        ["USPS clear zone (back)", describeClearZones(size)]
      ]),
      qr.problem ? `\n⚠️ ${qr.problem}` : qr.note ? `\n${qr.note}` : "",
      CLEAR_ZONE_CHECK,
      "",
      next ||
        (template.source === "yours"
          ? "The preview shows sample owner data. To mail it, call spur_preview_postcard_campaign with owner_ids."
          : `To redesign or mail it, first copy it: spur_create_postcard_template with base_template_id="${template.id}".`),
      PREVIEW_GUIDANCE
    ].join("\n");
    const result = structuredResult(text, {
      view: "postcard-preview",
      mail_type: "postcard",
      mode: "template",
      template: { id: template.id, name: template.name, size, inches: SIZE_INCHES[size], is_default: template.source !== "yours" },
      front_html: html.front,
      back_html: html.back,
      merge_fields: fields,
      clear_zone: clearZonePayload(size),
      sample: { label: "Sample data" }
    });
    return withWidgetArtwork(result, html);
  };

  server.registerTool(
    "spur_list_postcard_templates",
    {
      title: "List postcard templates",
      description:
        "Postcard templates available to the user: their own (editable), Spur defaults, and Spur's built-in gallery. Copy a default or gallery design with spur_create_postcard_template base_template_id to redesign it, or start from blank with start_from_blank.",
      inputSchema: z.strictObject({
        category: z.string().optional().describe("Only templates in this category, e.g. \"Just Sold\""),
        size: sizeField.optional().describe("Only templates designed for this size"),
        include_gallery: z.boolean().default(true).describe("Include Spur's built-in gallery designs")
      }),
      annotations: READ_ONLY
    },
    async ({ category, size, include_gallery }, ctx) => {
      const lists = await mail.listTemplates("postcard", category, include_gallery, ctx.mcpReq.signal);
      const bySize = (list: Template[]) => (size ? list.filter(t => normalizeSize(t.size) === size) : list);
      const mine = bySize(lists.mine);
      const defaults = bySize(lists.defaults);
      const gallery = bySize(lists.gallery);
      const all = [...mine, ...defaults, ...gallery];
      if (!all.length) return textResult("No postcard templates found. Create one with spur_create_postcard_template (start_from_blank=true for an empty canvas).");
      const text = [
        `# ${all.length} postcard templates`,
        mine.length ? `\n## Yours\n${mine.map(templateLine).join("\n")}` : "",
        defaults.length ? `\n## Spur defaults\n${defaults.map(templateLine).join("\n")}` : "",
        gallery.length ? `\n## Spur gallery\n${gallery.map(templateLine).join("\n")}` : ""
      ].join("\n");
      return structuredResult(text, { templates: all.map(t => ({ id: t.id, name: t.name, size: t.size, source: t.source, editable: t.source === "yours" })) });
    }
  );

  server.registerTool(
    "spur_get_postcard_template",
    {
      title: "Get postcard template HTML",
      description: `Fetch a postcard template's HTML for reading or editing. For small text changes prefer spur_update_postcard_template with replacements instead of resending whole HTML.`,
      inputSchema: z.strictObject({
        template_id: templateIdField,
        side: z.enum(["front", "back", "both"]).default("both").describe("Which side's HTML to return")
      }),
      annotations: READ_ONLY
    },
    async ({ template_id, side }, ctx) => {
      const t = await getTemplate(template_id, ctx.mcpReq.signal);
      const fields = mergeFieldsIn(t.front_html, t.back_html);
      const header = [
        `# ${t.name} (template_id: ${t.id})`,
        bullets([["Size", t.size || "6x4"], ["Editable", t.source === "yours" ? "yes" : `no (${sourceLabel(t)})`], ["Merge fields", fields.join(", ")]])
      ].join("\n");
      const front = side !== "back" ? `\n\n## Front HTML\n\`\`\`html\n${t.front_html || ""}\n\`\`\`` : "";
      const back = side !== "front" ? `\n\n## Back HTML\n\`\`\`html\n${t.back_html || ""}\n\`\`\`` : "";
      const text = header + front + back;
      if (side === "both" && text.length > 24_000) {
        return textResult(`${header}\n\nThis template is large. Call again with side="front", then side="back".`);
      }
      return textResult(text);
    }
  );

  registerAppTool(
    server,
    "spur_preview_postcard_template",
    {
      title: "Preview postcard template",
      description: "Show any postcard template (yours, a Spur default or a gallery design) rendered with sample data, without changing anything.",
      inputSchema: z.strictObject({ template_id: templateIdField }),
      annotations: READ_ONLY,
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Rendering postcard…", "Postcard preview")
    },
    async ({ template_id }, ctx) => {
      const template = await getTemplate(template_id, ctx.mcpReq.signal);
      return templatePreview(template, ctx.mcpReq.signal, `Postcard **${template.name}** (template_id: ${template.id}).`);
    }
  );

  registerAppTool(
    server,
    "spur_create_postcard_template",
    {
      title: "Create postcard template",
      description: `Create a postcard template and show a preview. Three ways to start:
- From blank: start_from_blank=true gives an empty, correctly sized canvas for the size (any side you pass HTML for replaces the blank side).
- Redesign an existing template: base_template_id (yours, a Spur default or a gallery id) copies its HTML; override front_html/back_html/size as needed.
- From scratch: pass both front_html and back_html.

${DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Template name shown in Spur"),
        start_from_blank: z.boolean().optional().describe("Start from an empty canvas sized for `size`"),
        base_template_id: templateIdField.optional().describe("Copy this template's HTML and size as the starting point"),
        front_html: z.string().max(500_000).optional().describe("Full front-side HTML"),
        back_html: z.string().max(500_000).optional().describe("Full back-side HTML; keep the address block area clear"),
        size: sizeField.optional(),
        description: z.string().max(1000).optional().describe("Internal note about the template; never printed"),
        category: z.string().max(100).optional().describe("Category label, e.g. \"Just Sold\" or \"Market Update\"")
      }),
      annotations: WRITE,
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Creating postcard…", "Postcard created")
    },
    async (args, ctx) => {
      if (args.start_from_blank && args.base_template_id) {
        return { ...textResult("Use either start_from_blank or base_template_id, not both."), isError: true };
      }
      const base = args.base_template_id ? await getTemplate(args.base_template_id, ctx.mcpReq.signal) : undefined;
      const size = args.size ?? normalizeSize(base?.size);
      const blank = args.start_from_blank ? blankPostcard(size) : undefined;
      const front_html = args.front_html ?? base?.front_html ?? blank?.front_html;
      const back_html = args.back_html ?? base?.back_html ?? blank?.back_html;
      if (!front_html || !back_html) {
        return { ...textResult("Provide both front_html and back_html, a base_template_id to copy from, or start_from_blank=true."), isError: true };
      }
      const created = await spur.data<Template>("POST", "/direct-mail/templates", {
        body: {
          name: args.name,
          type: "postcard",
          front_html,
          back_html,
          size,
          description: args.description ?? base?.description ?? null,
          category: args.category ?? base?.category ?? null,
          metadata: { source: "mcp", ...(base ? { copied_from: base.id } : {}), ...(blank ? { started_from: "blank" } : {}) }
        },
        signal: ctx.mcpReq.signal
      });
      const resized = base && normalizeSize(base.size) !== size ? ` Resized from ${normalizeSize(base.size)}; Spur scales the artwork to ${size} when printing, so check the preview.` : "";
      return templatePreview(
        { ...created, source: "yours" },
        ctx.mcpReq.signal,
        `Created postcard template **${created.name}** (template_id: ${created.id})${blank ? " from a blank canvas" : base ? ` from "${base.name}"` : ""}.${resized}`,
        blank && !args.front_html && !args.back_html
          ? "The canvas is empty. Design it with spur_update_postcard_template (front_html/back_html), then preview with recipients via spur_preview_postcard_campaign."
          : undefined
      );
    }
  );

  registerAppTool(
    server,
    "spur_update_postcard_template",
    {
      title: "Edit postcard template",
      description: `Edit one of the user's postcard templates and show the updated preview. For text tweaks pass replacements (exact find → replace on a side); to redesign, pass full front_html/back_html. Spur default and gallery templates can't be edited: copy them first with spur_create_postcard_template base_template_id.

Example: change the headline -> replacements=[{side:"front", find:"Just Sold!", replace:"Just Listed!"}]

${DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        template_id: uuid("Template"),
        name: z.string().min(1).max(255).optional().describe("New template name"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never printed"),
        category: z.string().max(100).optional().describe("Category label, e.g. \"Just Sold\" or \"Market Update\""),
        size: sizeField.optional(),
        front_html: z.string().max(500_000).optional().describe("Full replacement front HTML"),
        back_html: z.string().max(500_000).optional().describe("Full replacement back HTML"),
        replacements: z
          .array(
            z.strictObject({
              side: z.enum(["front", "back"]).describe("Which side to edit"),
              find: z.string().min(1).describe("Exact text that occurs once on that side"),
              replace: z.string()
            })
          )
          .max(30)
          .optional()
          .describe("Small edits applied in order instead of resending the full content")
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Updating postcard…", "Postcard updated")
    },
    async (args, ctx) => {
      const current = await getTemplate(args.template_id, ctx.mcpReq.signal);
      if (current.source !== "yours") {
        return {
          ...textResult(`"${current.name}" is a ${sourceLabel(current)} and can't be edited. Call spur_create_postcard_template with base_template_id="${current.id}" to make an editable copy.`),
          isError: true
        };
      }
      let front = args.front_html ?? current.front_html ?? "";
      let back = args.back_html ?? current.back_html ?? "";
      for (const r of args.replacements || []) {
        const source = r.side === "front" ? front : back;
        const count = source.split(r.find).length - 1;
        if (count !== 1) {
          return {
            ...textResult(
              `Replacement on the ${r.side} failed: "${r.find.slice(0, 80)}" occurs ${count} times (needs exactly 1). Nothing was saved. Use spur_get_postcard_template to see the HTML and pick a unique snippet.`
            ),
            isError: true
          };
        }
        const next = source.replace(r.find, () => r.replace);
        if (r.side === "front") front = next;
        else back = next;
      }

      const updates: Record<string, unknown> = {};
      if (args.name) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.category !== undefined) updates.category = args.category;
      if (args.size) updates.size = args.size;
      if (front !== current.front_html) updates.front_html = front;
      if (back !== current.back_html) updates.back_html = back;
      if (!Object.keys(updates).length) return textResult("Nothing to change: the template already matches.");

      const updated = await spur.data<Template>("PUT", `/direct-mail/templates/${encodeURIComponent(args.template_id)}`, {
        body: updates,
        signal: ctx.mcpReq.signal
      });
      const changed = Object.keys(updates).map(k => k.replace("_html", " HTML")).join(", ");
      return templatePreview({ ...updated, source: "yours" }, ctx.mcpReq.signal, `Updated **${updated.name}** (template_id: ${updated.id}): ${changed}.`);
    }
  );

  /** Loads one of the user's own templates, or the error result explaining why it can't be edited */
  const editableTemplate = async (id: string, signal: AbortSignal) => {
    const template = await getTemplate(id, signal);
    if (template.source === "yours") return { template };
    return {
      error: {
        ...textResult(`"${template.name}" is a ${sourceLabel(template)} and can't be edited. Call spur_create_postcard_template with base_template_id="${template.id}" to make an editable copy.`),
        isError: true
      }
    };
  };

  registerAppTool(
    server,
    "spur_add_postcard_qr_code",
    {
      title: "Add QR code to postcard",
      description: `Put a tracked QR code on the back of one of the user's postcard templates and show the preview. Each mailed postcard gets its own code under the chosen QR code, so scans are tracked per recipient (spur_get_qr_code_activity).

Placement: position="auto" fills the back's QR slot (an element with class qr-box, qr-code-box, qr-placeholder or qr-callout-box, as Spur's gallery designs have) and otherwise goes in the bottom-right of the message area, left of the address block and above the USPS barcode. Corners (top_left, top_right, bottom_left, bottom_right) and x_inches/y_inches place it in the message area; spots in the USPS clear zone are refused. Replaces any QR already on the card. If it lands on the message text, call again with another corner or move the text.

Create a QR code first with spur_create_qr_code if spur_list_qr_codes has none that fits.`,
      inputSchema: z.strictObject({
        template_id: uuid("Postcard template"),
        qr_code_id: uuid("QR code").describe("QR code id from spur_list_qr_codes or spur_create_qr_code"),
        position: z.enum(QR_POSITIONS).default("auto").describe("Where to place the code on the back; auto fills the design's qr-box"),
        size_inches: z.number().min(0.6).max(2).default(1).describe("Edge length when placed in the message area (not used for a slot). 0.75in or more scans reliably"),
        x_inches: z.number().min(0).max(12).optional().describe("Left edge, inches from the bleed's left edge (with y_inches; overrides position)"),
        y_inches: z.number().min(0).max(7).optional().describe("Top edge, inches from the bleed's top edge (with x_inches)")
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Adding QR code…", "QR code added")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      if ((args.x_inches === undefined) !== (args.y_inches === undefined)) {
        return { ...textResult("Pass both x_inches and y_inches, or neither (to use position)."), isError: true };
      }
      const [loaded, codes] = await Promise.all([editableTemplate(args.template_id, signal), listQrCodes(spur, signal)]);
      if (loaded.error) return loaded.error;
      const { template } = loaded;
      const qr = codes.find(c => c.id === args.qr_code_id);
      if (!qr) {
        return {
          ...textResult(`QR code ${args.qr_code_id} not found. ${codes.length ? "Call spur_list_qr_codes for the user's codes" : "The user has none yet; create one with spur_create_qr_code"}.`),
          isError: true
        };
      }

      const size = normalizeSize(template.size);
      const at = args.x_inches !== undefined && args.y_inches !== undefined ? { x: args.x_inches, y: args.y_inches } : undefined;
      const placed = placeQrPlaceholder(template.back_html || "", size, qr, { position: args.position, sizeInches: args.size_inches, at });
      if (!placed.ok) return { ...textResult(placed.error), isError: true };
      // One parent per card: the backend mints codes for the first one it finds
      const front = removeQrPlaceholders(template.front_html || "");

      const updates: Record<string, unknown> = { back_html: placed.html };
      if (front.removed) updates.front_html = front.html;
      const updated = await spur.data<Template>("PUT", `/direct-mail/templates/${encodeURIComponent(template.id)}`, { body: updates, signal });

      const where =
        placed.placement === "slot"
          ? `in the back's QR slot (${placed.slot})`
          : `in the message area at x ${placed.box.x}in, y ${placed.box.y}in, ${placed.box.size}in square (from the bleed's top-left)${placed.anchored === "page" ? "; the back has no .postcard root, so it's placed relative to the page" : ""}`;
      const replaced = placed.replaced + front.removed;
      return templatePreview(
        { ...updated, source: "yours" },
        signal,
        `Added QR code **${qr.name}** (→ ${qr.destination_url}) to **${updated.name}** ${where}.${replaced ? ` Replaced the QR that was there.` : ""} The preview shows a sample code; each mailed postcard gets its own.${placed.placement === "message_area" ? " Check it doesn't cover the message text; if it does, call again with another position or move the text." : ""}`
      );
    }
  );

  registerAppTool(
    server,
    "spur_remove_postcard_qr_code",
    {
      title: "Remove QR code from postcard",
      description: "Remove the tracked QR code from one of the user's postcard templates (both sides) and show the preview. A QR slot from the design stays, empty.",
      inputSchema: z.strictObject({ template_id: uuid("Postcard template") }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Removing QR code…", "QR code removed")
    },
    async ({ template_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const loaded = await editableTemplate(template_id, signal);
      if (loaded.error) return loaded.error;
      const { template } = loaded;
      const front = removeQrPlaceholders(template.front_html || "");
      const back = removeQrPlaceholders(template.back_html || "");
      if (!front.removed && !back.removed) return textResult(`"${template.name}" has no QR code to remove.`);
      const updates: Record<string, unknown> = {};
      if (front.removed) updates.front_html = front.html;
      if (back.removed) updates.back_html = back.html;
      const updated = await spur.data<Template>("PUT", `/direct-mail/templates/${encodeURIComponent(template.id)}`, { body: updates, signal });
      return templatePreview({ ...updated, source: "yours" }, signal, `Removed the QR code from **${updated.name}** (template_id: ${updated.id}).`);
    }
  );

  server.registerTool(
    "spur_delete_postcard_template",
    {
      title: "Delete postcard template",
      description: "Permanently delete one of the user's postcard templates. Spur defaults can't be deleted. Confirm with the user first.",
      inputSchema: z.strictObject({ template_id: uuid("Template"), confirm: confirmField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ template_id }, ctx) => {
      await spur.request("DELETE", `/direct-mail/templates/${encodeURIComponent(template_id)}`, { signal: ctx.mcpReq.signal });
      return textResult(`Deleted postcard template ${template_id}.`);
    }
  );

  server.registerTool(
    "spur_list_return_addresses",
    {
      title: "List return addresses",
      description: "Return addresses saved for direct mail. The default one is used when a campaign doesn't specify one.",
      annotations: READ_ONLY
    },
    async ctx => {
      const addresses = await mail.getReturnAddresses(ctx.mcpReq.signal);
      if (!addresses.length) return textResult("No return addresses yet. Add one in Spur → Direct Mail → Return addresses before mailing.");
      return textResult(
        [`# Return addresses`, ...addresses.map(a => `- **${a.name}** (return_address_id: ${a.id})${a.is_default ? " — default" : ""}: ${formatAddress(a)}`)].join("\n")
      );
    }
  );

  registerAppTool(
    server,
    "spur_preview_postcard_campaign",
    {
      title: "Preview postcard mailing",
      description: `Required step before mailing postcards. Renders the postcard with the first recipient's real data, checks which owners have mailing addresses, estimates the cost from the user's plan, and returns a confirmation_token.

Show the preview, then ask the user to approve. Only after they approve, call spur_send_postcards with the token (the widget's Send button does the same). The token expires in 30 minutes and only covers this exact template, recipient set, return address and size.`,
      inputSchema: z.strictObject({
        template_id: uuid("Postcard template"),
        owner_ids: z.array(z.string()).min(1).max(MAX_RECIPIENTS).describe("Owners to mail (spur_find_owners)"),
        return_address_id: z.string().optional().describe("Defaults to the user's default return address"),
        size: sizeField.optional().describe("Defaults to the template's size")
      }),
      annotations: { ...READ_ONLY, idempotentHint: false },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Preparing postcard preview…", "Preview ready")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [template, campaign] = await Promise.all([getTemplate(args.template_id, signal), mail.resolveCampaign(args.owner_ids, args.return_address_id, signal)]);
      if (template.source === "gallery") {
        return {
          ...textResult(`"${template.name}" is a Spur gallery design. Copy it with spur_create_postcard_template base_template_id="${template.id}", then preview the copy.`),
          isError: true
        };
      }
      if ("error" in campaign) return { ...textResult(campaign.error as string), isError: true };
      const qr = await qrStatus(template, signal);
      if (qr.problem) return { ...textResult(qr.problem), isError: true };
      const { ownerIds, returnAddress, unknown, noAddress, mailable, sampleOwner, billing } = campaign;

      const merge = { ...(await mail.mergeDataFor(sampleOwner.id, signal)), ...senderMergeData(returnAddress) };
      const html = await mail.renderPostcard(template, merge, signal);
      const size = args.size ?? normalizeSize(template.size);
      const { summary, cost } = estimateCost(billing, "postcard", mailable.length, { variantKey: size });

      const token: LaunchToken = { tid: template.id, oids: mailable, rid: returnAddress.id, size, n: mailable.length, exp: nowSeconds() + LAUNCH_TOKEN_TTL_SECONDS };
      const confirmationToken = sealer.seal("launch", token);

      const text = [
        `# Postcard preview: ${template.name}`,
        bullets([
          ["Recipients", `${mailable.length} mailable of ${ownerIds.length} requested`],
          ["Skipped (no mailing address)", noAddress.length || undefined],
          ["Skipped (not found)", unknown.length || undefined],
          ["Size", size],
          ["Return address", formatAddress(returnAddress)],
          ["Preview personalized for", sampleOwner.full_name || sampleOwner.id],
          ["Estimated cost", summary],
          ["QR code", qr.label],
          ["Wallet balance", cost.wallet_balance_usd !== null ? `$${cost.wallet_balance_usd.toFixed(2)}` : undefined],
          ["USPS clear zone (back)", describeClearZones(size)]
        ]),
        cost.wallet_short ? "\n⚠️ The estimate exceeds the wallet balance; the send will fail until the user tops up. Offer spur_top_up_wallet for at least the difference." : "",
        qr.note ? `\n${qr.note}` : "",
        "",
        CLEAR_ZONE_CHECK,
        `Ask the user to approve mailing ${mailable.length} postcards. Only after they say yes, call spur_send_postcards with confirmation_token="${confirmationToken}" and confirm=true. Token expires ${date(new Date(token.exp * 1000).toISOString())} (30 min).`,
        PREVIEW_GUIDANCE
      ].join("\n");

      const result = structuredResult(text, {
        view: "postcard-preview",
        mail_type: "postcard",
        mode: "campaign",
        template: { id: template.id, name: template.name, size, inches: SIZE_INCHES[size], is_default: !!template.is_default },
        front_html: html.front,
        back_html: html.back,
        merge_fields: mergeFieldsIn(template.front_html, template.back_html),
        clear_zone: clearZonePayload(size),
        sample: { label: sampleOwner.full_name || "First recipient", owner_id: sampleOwner.id, mailing_address: sampleOwner.mailing_address },
        recipients: { requested: ownerIds.length, mailable: mailable.length, no_address: noAddress.length, not_found: unknown.length },
        return_address: { id: returnAddress.id, label: formatAddress(returnAddress) },
        cost,
        confirmation_token: confirmationToken,
        expires_at: new Date(token.exp * 1000).toISOString()
      });
      return withWidgetArtwork(result, html);
    }
  );

  registerAppTool(
    server,
    "spur_send_postcards",
    {
      title: "Send postcards",
      description: `Mail the postcards approved in spur_preview_postcard_campaign. Irreversible and charges the user's account. Requires the preview's confirmation_token and the user's explicit approval (confirm=true).`,
      inputSchema: z.strictObject({
        confirmation_token: z.string().min(20).describe("confirmation_token from spur_preview_postcard_campaign"),
        confirm: confirmField
      }),
      annotations: OUTWARD,
      _meta: { ui: { resourceUri: POSTCARD_PREVIEW_URI, visibility: ["model", "app"] } }
    },
    async ({ confirmation_token }, ctx) => {
      const token = sealer.unseal<LaunchToken>("launch", confirmation_token);
      if (!token) return { ...textResult("That confirmation token is invalid. Run spur_preview_postcard_campaign again."), isError: true };
      if (token.exp <= nowSeconds()) {
        return { ...textResult("The preview expired (30 min). Run spur_preview_postcard_campaign again and get approval on the fresh preview."), isError: true };
      }
      const result = await spur.request<{ data?: { batch_id?: string; recipient_count?: number; status?: string } }>("POST", "/direct-mail/orders/bulk", {
        body: {
          type: "postcard",
          source: "owners",
          owner_ids: token.oids,
          template_id: token.tid,
          return_address_id: token.rid,
          size: token.size,
          metadata: { source: "mcp" },
          send_immediately: true
        },
        signal: ctx.mcpReq.signal
      });
      const queued = result.data?.recipient_count ?? token.n;
      return structuredResult(
        `Queued ${queued} postcards for mailing (batch ${result.data?.batch_id || "n/a"}). Track delivery with spur_get_direct_mail_analytics.`,
        { status: result.data?.status || "queued", batch_id: result.data?.batch_id || null, recipient_count: queued }
      );
    }
  );
}
