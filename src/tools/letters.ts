/**
 * Letters: template CRUD for both letter formats, previews with real merge data, and the
 * preview → confirm → send flow.
 *
 * Same guardrails as postcards: spur_send_letters only accepts a token minted by
 * spur_preview_letter_campaign, sealed for letters and bound to exactly that template, letter
 * format, print options, recipient set and return address.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { nowSeconds } from "../auth/seal.js";
import { POSTCARD_PREVIEW_URI, widgetMeta } from "../widgets.js";
import {
  blankLetter,
  createMailHelpers,
  estimateCost,
  formatAddress,
  LAUNCH_TOKEN_TTL_SECONDS,
  LETTER_TYPE_SUMMARY,
  LETTER_TYPE_TAGS,
  LETTER_TYPES,
  letterTypeOf,
  MAX_RECIPIENTS,
  mergeFieldsIn,
  PREVIEW_GUIDANCE,
  senderMergeData,
  sourceLabel,
  withWidgetArtwork,
  type LetterType,
  type Template
} from "./mail.js";
import { bullets, confirmField, date, OUTWARD, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

interface LetterLaunchToken {
  tid: string;
  oids: string[];
  rid: string;
  ap: LetterType;
  color: boolean;
  ds: boolean;
  n: number;
  exp: number;
}

const LETTER_INCHES: [number, number] = [8.5, 11];

const letterTypeField = z
  .enum(LETTER_TYPES)
  .describe(
    '"top_first_page": the address prints in the top 3.15in of page 1 (shows through a #10 window envelope), so keep that band empty. "insert_blank_page": Spur adds a separate address page in front, so the letter can use the whole page (one extra page is billed).'
  );
const templateIdField = z.string().min(1).max(128).describe("Template id from spur_list_letter_templates (a saved template's UUID or a Spur gallery id)");

const DESIGN_GUIDANCE = `HTML guidance (see spur://letter-design-guide): one US Letter page (8.5"×11"), full HTML document with inline <style>, "@page { size: 8.5in 11in; margin: 0; }", no scripts. One root <div class="letter"> 8.5in wide; px/in units only (no vh/vw); no box-shadow, transforms or manual page breaks. top_first_page: leave the first 3.15in blank (an empty <div class="address-zone" style="height:3.15in">), body ≈ 3–4 short paragraphs. insert_blank_page: no address zone; letterhead up to 1.8in, body up to ~400 words. Images as absolute https URLs. The user's own images (logo, headshot, property photos): spur_list_images gives their URLs; if they want to use an image they have, call spur_upload_image (or spur_save_image for a link) and use the saved URL. Use merge fields such as {{owner_first_name}}, {{property_address}}, {{your_name}}, {{your_phone}}, {{company_name}} (see spur://merge-variables).`;

function templateLine(t: Template): string {
  return `- **${t.name}** (template_id: ${t.id}) — ${LETTER_TYPE_TAGS[letterTypeOf(t)]}${t.category ? `, ${t.category}` : ""}, ${sourceLabel(t)}${t.description ? ` — ${t.description}` : ""}`;
}

export function registerLetterTools({ server, spur, sealer }: ToolContext) {
  const mail = createMailHelpers(spur);
  const getTemplate = (id: string, signal: AbortSignal) => mail.loadTemplate(id, "letter", signal);

  const letterPayload = (template: Template, letterType: LetterType, html: string) => ({
    view: "postcard-preview",
    mail_type: "letter",
    template: { id: template.id, name: template.name, size: "us_letter", inches: LETTER_INCHES, is_default: template.source !== "yours" },
    letter: { type: letterType, label: LETTER_TYPE_TAGS[letterType] },
    html,
    merge_fields: mergeFieldsIn(template.html_content)
  });

  const templatePreview = async (template: Template, signal: AbortSignal, heading: string, next?: string) => {
    const letterType = letterTypeOf(template);
    const html = await mail.renderLetter(template.html_content || "", letterType, await mail.sampleMergeData(signal), signal);
    const fields = mergeFieldsIn(template.html_content);
    const text = [
      heading,
      bullets([
        ["Name", template.name],
        ["Letter type", `${LETTER_TYPE_TAGS[letterType]} — ${LETTER_TYPE_SUMMARY[letterType]}`],
        ["Source", sourceLabel(template)],
        ["Merge fields", fields.length ? fields.map(f => `{{${f}}}`).join(", ") : "none"]
      ]),
      "",
      next ||
        (template.source === "yours"
          ? "The preview shows sample owner data. To mail it, call spur_preview_letter_campaign with owner_ids."
          : `To redesign or mail it, first copy it: spur_create_letter_template with base_template_id="${template.id}".`),
      PREVIEW_GUIDANCE
    ].join("\n");
    const result = structuredResult(text, { ...letterPayload(template, letterType, html), mode: "template", sample: { label: "Sample data" } });
    return withWidgetArtwork(result, { letter: html });
  };

  server.registerTool(
    "spur_list_letter_templates",
    {
      title: "List letter templates",
      description:
        "Letter templates available to the user, with their letter type (Top First Page or Insert Blank Page): their own (editable), Spur defaults, and Spur's built-in gallery. Copy one with spur_create_letter_template base_template_id to redesign it, or start from blank with start_from_blank.",
      inputSchema: z.strictObject({
        category: z.string().optional().describe("Only templates in this category"),
        letter_type: letterTypeField.optional().describe("Only templates of this letter type"),
        include_gallery: z.boolean().default(true).describe("Include Spur's built-in gallery designs")
      }),
      annotations: READ_ONLY
    },
    async ({ category, letter_type, include_gallery }, ctx) => {
      const lists = await mail.listTemplates("letter", category, include_gallery, ctx.mcpReq.signal);
      const byType = (list: Template[]) => (letter_type ? list.filter(t => letterTypeOf(t) === letter_type) : list);
      const mine = byType(lists.mine);
      const defaults = byType(lists.defaults);
      const gallery = byType(lists.gallery);
      const all = [...mine, ...defaults, ...gallery];
      if (!all.length) return textResult("No letter templates found. Create one with spur_create_letter_template (start_from_blank=true for an empty page).");
      const text = [
        `# ${all.length} letter templates`,
        mine.length ? `\n## Yours\n${mine.map(templateLine).join("\n")}` : "",
        defaults.length ? `\n## Spur defaults\n${defaults.map(templateLine).join("\n")}` : "",
        gallery.length ? `\n## Spur gallery\n${gallery.map(templateLine).join("\n")}` : ""
      ].join("\n");
      return structuredResult(text, {
        templates: all.map(t => ({ id: t.id, name: t.name, letter_type: letterTypeOf(t), source: t.source, editable: t.source === "yours" }))
      });
    }
  );

  server.registerTool(
    "spur_get_letter_template",
    {
      title: "Get letter template HTML",
      description: "Fetch a letter template's HTML for reading or editing. For small text changes prefer spur_update_letter_template with replacements instead of resending the whole HTML.",
      inputSchema: z.strictObject({ template_id: templateIdField }),
      annotations: READ_ONLY
    },
    async ({ template_id }, ctx) => {
      const t = await getTemplate(template_id, ctx.mcpReq.signal);
      const header = [
        `# ${t.name} (template_id: ${t.id})`,
        bullets([
          ["Letter type", LETTER_TYPE_TAGS[letterTypeOf(t)]],
          ["Editable", t.source === "yours" ? "yes" : `no (${sourceLabel(t)})`],
          ["Merge fields", mergeFieldsIn(t.html_content).join(", ")]
        ])
      ].join("\n");
      const html = t.html_content || "";
      if (html.length > 40_000) {
        return textResult(`${header}\n\nThis template's HTML is ${Math.round(html.length / 1000)} KB, too large to return whole. Use spur_update_letter_template replacements for edits, or redesign it with new html.`);
      }
      return textResult(`${header}\n\n## HTML\n\`\`\`html\n${html}\n\`\`\``);
    }
  );

  registerAppTool(
    server,
    "spur_preview_letter_template",
    {
      title: "Preview letter template",
      description: "Show any letter template (yours, a Spur default or a gallery design) rendered with sample data, without changing anything.",
      inputSchema: z.strictObject({ template_id: templateIdField }),
      annotations: READ_ONLY,
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Rendering letter…", "Letter preview")
    },
    async ({ template_id }, ctx) => {
      const template = await getTemplate(template_id, ctx.mcpReq.signal);
      return templatePreview(template, ctx.mcpReq.signal, `Letter **${template.name}** (template_id: ${template.id}).`);
    }
  );

  registerAppTool(
    server,
    "spur_create_letter_template",
    {
      title: "Create letter template",
      description: `Create a letter template and show a preview. Pick the letter type first (top_first_page or insert_blank_page); it decides where the address prints and how much of the page the design can use. Three ways to start:
- From blank: start_from_blank=true gives an empty one-page letter laid out for the letter type.
- Redesign an existing template: base_template_id (yours, a Spur default or a gallery id) copies its HTML and letter type; override html or letter_type as needed.
- From scratch: pass html.

${DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Template name shown in Spur"),
        letter_type: letterTypeField.optional().describe("Defaults to the base template's type, else top_first_page"),
        start_from_blank: z.boolean().optional().describe("Start from an empty page laid out for letter_type"),
        base_template_id: templateIdField.optional().describe("Copy this template's HTML and letter type as the starting point"),
        html: z.string().max(500_000).optional().describe("Full letter HTML"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never printed"),
        category: z.string().max(100).optional().describe("Category label, e.g. \"Seller Outreach\"")
      }),
      annotations: WRITE,
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Creating letter…", "Letter created")
    },
    async (args, ctx) => {
      if (args.start_from_blank && args.base_template_id) {
        return { ...textResult("Use either start_from_blank or base_template_id, not both."), isError: true };
      }
      const base = args.base_template_id ? await getTemplate(args.base_template_id, ctx.mcpReq.signal) : undefined;
      const letterType = args.letter_type ?? (base ? letterTypeOf(base) : "top_first_page");
      const html = args.html ?? base?.html_content ?? (args.start_from_blank ? blankLetter(letterType) : undefined);
      if (!html) return { ...textResult("Provide html, a base_template_id to copy from, or start_from_blank=true."), isError: true };

      const created = await spur.data<Template>("POST", "/direct-mail/templates", {
        body: {
          name: args.name,
          type: "letter",
          html_content: html,
          size: "us_letter",
          letter_template_tag: LETTER_TYPE_TAGS[letterType],
          description: args.description ?? base?.description ?? null,
          category: args.category ?? base?.category ?? null,
          metadata: {
            source: "mcp",
            address_placement: letterType,
            ...(base ? { copied_from: base.id } : {}),
            ...(args.start_from_blank ? { started_from: "blank" } : {})
          }
        },
        signal: ctx.mcpReq.signal
      });
      const switched =
        base && !args.html && letterTypeOf(base) !== letterType
          ? ` Switched from ${LETTER_TYPE_TAGS[letterTypeOf(base)]} to ${LETTER_TYPE_TAGS[letterType]}: the design was laid out for the other type, so check the address area in the preview and adjust the HTML.`
          : "";
      return templatePreview(
        { ...created, source: "yours", letter_template_tag: created.letter_template_tag ?? LETTER_TYPE_TAGS[letterType] },
        ctx.mcpReq.signal,
        `Created ${LETTER_TYPE_TAGS[letterType]} letter template **${created.name}** (template_id: ${created.id})${args.start_from_blank ? " from a blank page" : base ? ` from "${base.name}"` : ""}.${switched}`,
        args.start_from_blank && !args.html
          ? "The page is a blank starter (greeting and signature only). Write the letter with spur_update_letter_template (html or replacements), then preview with recipients via spur_preview_letter_campaign."
          : undefined
      );
    }
  );

  registerAppTool(
    server,
    "spur_update_letter_template",
    {
      title: "Edit letter template",
      description: `Edit one of the user's letter templates and show the updated preview. For text tweaks pass replacements (exact find → replace); to redesign, pass full html. letter_type switches between top_first_page and insert_blank_page. Spur default and gallery templates can't be edited: copy them first with spur_create_letter_template base_template_id.

${DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        template_id: uuid("Template"),
        name: z.string().min(1).max(255).optional().describe("New template name"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never printed"),
        category: z.string().max(100).optional().describe("Category label, e.g. \"Seller Outreach\""),
        letter_type: letterTypeField.optional(),
        html: z.string().max(500_000).optional().describe("Full replacement HTML"),
        replacements: z
          .array(z.strictObject({ find: z.string().min(1).describe("Exact text that occurs once in the HTML"), replace: z.string().describe("Text to put in its place") }))
          .max(30)
          .optional()
          .describe("Small edits applied in order instead of resending the full content")
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Updating letter…", "Letter updated")
    },
    async (args, ctx) => {
      const current = await getTemplate(args.template_id, ctx.mcpReq.signal);
      if (current.source !== "yours") {
        return {
          ...textResult(`"${current.name}" is a ${sourceLabel(current)} and can't be edited. Call spur_create_letter_template with base_template_id="${current.id}" to make an editable copy.`),
          isError: true
        };
      }
      let html = args.html ?? current.html_content ?? "";
      for (const r of args.replacements || []) {
        const count = html.split(r.find).length - 1;
        if (count !== 1) {
          return {
            ...textResult(
              `Replacement failed: "${r.find.slice(0, 80)}" occurs ${count} times (needs exactly 1). Nothing was saved. Use spur_get_letter_template to see the HTML and pick a unique snippet.`
            ),
            isError: true
          };
        }
        html = html.replace(r.find, () => r.replace);
      }

      const updates: Record<string, unknown> = {};
      if (args.name) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.category !== undefined) updates.category = args.category;
      if (html !== current.html_content) updates.html_content = html;
      if (args.letter_type && args.letter_type !== letterTypeOf(current)) {
        updates.letter_template_tag = LETTER_TYPE_TAGS[args.letter_type];
        updates.metadata = { address_placement: args.letter_type };
      }
      if (!Object.keys(updates).length) return textResult("Nothing to change: the template already matches.");

      const updated = await spur.data<Template>("PUT", `/direct-mail/templates/${encodeURIComponent(args.template_id)}`, {
        body: updates,
        signal: ctx.mcpReq.signal
      });
      const changed = Object.keys(updates)
        .filter(k => k !== "metadata")
        .map(k => (k === "html_content" ? "HTML" : k === "letter_template_tag" ? "letter type" : k))
        .join(", ");
      return templatePreview({ ...updated, source: "yours" }, ctx.mcpReq.signal, `Updated **${updated.name}** (template_id: ${updated.id}): ${changed}.`);
    }
  );

  server.registerTool(
    "spur_delete_letter_template",
    {
      title: "Delete letter template",
      description: "Permanently delete one of the user's letter templates. Spur defaults can't be deleted. Confirm with the user first.",
      inputSchema: z.strictObject({ template_id: uuid("Template"), confirm: confirmField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ template_id }, ctx) => {
      await spur.request("DELETE", `/direct-mail/templates/${encodeURIComponent(template_id)}`, { signal: ctx.mcpReq.signal });
      return textResult(`Deleted letter template ${template_id}.`);
    }
  );

  registerAppTool(
    server,
    "spur_preview_letter_campaign",
    {
      title: "Preview letter mailing",
      description: `Required step before mailing letters. Renders the letter with the first recipient's real data in its letter type's layout, checks which owners have mailing addresses, estimates the cost from the user's plan (Insert Blank Page letters include the extra address page), and returns a confirmation_token.

Show the preview, then ask the user to approve. Only after they approve, call spur_send_letters with the token (the widget's Send button does the same). The token expires in 30 minutes and only covers this exact template, letter type, print options, recipient set and return address.`,
      inputSchema: z.strictObject({
        template_id: uuid("Letter template"),
        owner_ids: z.array(z.string()).min(1).max(MAX_RECIPIENTS).describe("Owners to mail (spur_find_owners)"),
        return_address_id: z.string().optional().describe("Defaults to the user's default return address"),
        color: z.boolean().default(true).describe("Print in color (false for black and white)"),
        double_sided: z.boolean().default(false).describe("Print on both sides of each sheet")
      }),
      annotations: { ...READ_ONLY, idempotentHint: false },
      _meta: widgetMeta(POSTCARD_PREVIEW_URI, "Preparing letter preview…", "Preview ready")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [template, campaign] = await Promise.all([getTemplate(args.template_id, signal), mail.resolveCampaign(args.owner_ids, args.return_address_id, signal)]);
      if (template.source === "gallery") {
        return {
          ...textResult(`"${template.name}" is a Spur gallery design. Copy it with spur_create_letter_template base_template_id="${template.id}", then preview the copy.`),
          isError: true
        };
      }
      if ("error" in campaign) return { ...textResult(campaign.error as string), isError: true };
      const { ownerIds, returnAddress, unknown, noAddress, mailable, sampleOwner, billing } = campaign;

      const letterType = letterTypeOf(template);
      const merge = { ...(await mail.mergeDataFor(sampleOwner.id, signal)), ...senderMergeData(returnAddress) };
      const html = await mail.renderLetter(template.html_content || "", letterType, merge, signal);
      // The backend bills the inserted address page as one extra page
      const { summary, cost } = estimateCost(billing, "letter", mailable.length, { additionalUnits: letterType === "insert_blank_page" ? 1 : 0 });

      const token: LetterLaunchToken = {
        tid: template.id,
        oids: mailable,
        rid: returnAddress.id,
        ap: letterType,
        color: args.color,
        ds: args.double_sided,
        n: mailable.length,
        exp: nowSeconds() + LAUNCH_TOKEN_TTL_SECONDS
      };
      const confirmationToken = sealer.seal("letter-launch", token);

      const text = [
        `# Letter preview: ${template.name}`,
        bullets([
          ["Recipients", `${mailable.length} mailable of ${ownerIds.length} requested`],
          ["Skipped (no mailing address)", noAddress.length || undefined],
          ["Skipped (not found)", unknown.length || undefined],
          ["Letter type", `${LETTER_TYPE_TAGS[letterType]} — ${LETTER_TYPE_SUMMARY[letterType]}`],
          ["Printing", `${args.color ? "color" : "black and white"}, ${args.double_sided ? "double-sided" : "single-sided"}, US Letter in a #10 envelope`],
          ["Return address", formatAddress(returnAddress)],
          ["Preview personalized for", sampleOwner.full_name || sampleOwner.id],
          ["Estimated cost", summary],
          ["Wallet balance", cost.wallet_balance_usd !== null ? `$${cost.wallet_balance_usd.toFixed(2)}` : undefined]
        ]),
        cost.wallet_short ? "\n⚠️ The estimate exceeds the wallet balance; the send will fail until the user tops up. Offer spur_top_up_wallet for at least the difference." : "",
        "",
        `Ask the user to approve mailing ${mailable.length} letters. Only after they say yes, call spur_send_letters with confirmation_token="${confirmationToken}" and confirm=true. Token expires ${date(new Date(token.exp * 1000).toISOString())} (30 min).`,
        PREVIEW_GUIDANCE
      ].join("\n");

      const result = structuredResult(text, {
        ...letterPayload(template, letterType, html),
        mode: "campaign",
        print: { color: args.color, double_sided: args.double_sided },
        sample: { label: sampleOwner.full_name || "First recipient", owner_id: sampleOwner.id, mailing_address: sampleOwner.mailing_address },
        recipients: { requested: ownerIds.length, mailable: mailable.length, no_address: noAddress.length, not_found: unknown.length },
        return_address: { id: returnAddress.id, label: formatAddress(returnAddress) },
        cost,
        confirmation_token: confirmationToken,
        expires_at: new Date(token.exp * 1000).toISOString()
      });
      return withWidgetArtwork(result, { letter: html });
    }
  );

  registerAppTool(
    server,
    "spur_send_letters",
    {
      title: "Send letters",
      description: `Mail the letters approved in spur_preview_letter_campaign. Irreversible and charges the user's account. Requires the preview's confirmation_token and the user's explicit approval (confirm=true).`,
      inputSchema: z.strictObject({
        confirmation_token: z.string().min(20).describe("confirmation_token from spur_preview_letter_campaign"),
        confirm: confirmField
      }),
      annotations: OUTWARD,
      _meta: { ui: { resourceUri: POSTCARD_PREVIEW_URI, visibility: ["model", "app"] } }
    },
    async ({ confirmation_token }, ctx) => {
      const token = sealer.unseal<LetterLaunchToken>("letter-launch", confirmation_token);
      if (!token) return { ...textResult("That confirmation token is invalid. Run spur_preview_letter_campaign again."), isError: true };
      if (token.exp <= nowSeconds()) {
        return { ...textResult("The preview expired (30 min). Run spur_preview_letter_campaign again and get approval on the fresh preview."), isError: true };
      }
      const result = await spur.request<{ data?: { batch_id?: string; recipient_count?: number; status?: string } }>("POST", "/direct-mail/orders/bulk", {
        body: {
          type: "letter",
          source: "owners",
          owner_ids: token.oids,
          template_id: token.tid,
          return_address_id: token.rid,
          size: "us_letter",
          address_placement: token.ap,
          color: token.color,
          double_sided: token.ds,
          metadata: { source: "mcp", address_placement: token.ap },
          send_immediately: true
        },
        signal: ctx.mcpReq.signal
      });
      const queued = result.data?.recipient_count ?? token.n;
      return structuredResult(
        `Queued ${queued} letters for mailing (batch ${result.data?.batch_id || "n/a"}). Track delivery with spur_get_direct_mail_analytics.`,
        { status: result.data?.status || "queued", batch_id: result.data?.batch_id || null, recipient_count: queued }
      );
    }
  );
}
