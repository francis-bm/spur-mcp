/**
 * Email and SMS templates: design (blank starter, copy, full HTML or find/replace edits), preview
 * with sample or real owner data, save, and a test send to the user's own inbox. Saved templates
 * are what outreach workflow send_email / send_sms steps use (see spur_create_workflow).
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { inlineImages } from "../inlineImages.js";
import type { SpurClient } from "../spurApi.js";
import { MESSAGE_HTML_META, MESSAGE_PREVIEW_URI, widgetMeta } from "../widgets.js";
import { PREVIEW_GUIDANCE } from "./mail.js";
import { bullets, confirmField, date, OUTWARD, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

export type Channel = "email" | "sms";

export interface MessageTemplate {
  id: string;
  user_id?: string | null;
  template_name: string;
  template_description?: string | null;
  template_type: Channel | "direct_mail";
  subject?: string | null;
  body?: string | null;
  html_content?: string | null;
  fallback_body?: string | null;
  is_default?: boolean;
  is_active?: boolean;
  variables?: string[];
  updated_at?: string;
}

interface RenderedContent {
  subject: string | null;
  body: string;
  /** Unrendered plain text; generated from the HTML when no body was sent */
  source_body: string;
  html_content: string | null;
  fallback_body: string | null;
  variables: string[];
  unresolved_variables: string[];
}

interface EmailSender {
  id: string;
  name?: string | null;
  display_name?: string | null;
  email: string;
  is_default?: boolean;
  is_active?: boolean;
}

/** Backend validation limits (templateService.validateTemplateData) */
const MAX_EMAIL_HTML = 50_000;
const MAX_SMS_BODY = 1600;
/** Gmail clips messages over ~102 KB, hiding the rest (often the unsubscribe footer) */
const GMAIL_CLIP_BYTES = 102 * 1024;

const templateIdField = uuid("Email or SMS template");
const ownerIdField = z.string().optional().describe("Preview with this owner's real data (spur_find_owners) instead of sample data");

export const EMAIL_DESIGN_GUIDANCE = `Email HTML guidance (see spur://email-design-guide): full HTML document, table-based layout 600px wide, inline styles on elements (a small <style> block in <head> is fine for resets/media queries), web-safe font stacks, no JavaScript, no forms, no external CSS. Images as absolute https URLs with alt text and width attributes. The user's own images (logo, headshot, property photos): spur_list_images gives their URLs; if they want to use an image they have, call spur_upload_image (or spur_save_image for a link) and use the saved URL. Use PNG or JPG in emails, not SVG. A hidden preheader <div style="display:none"> right after <body> sets the inbox snippet. Include an opt-out line ("Reply STOP" or an unsubscribe link) and the sender's postal address in the footer. Keep it under 50,000 characters. Use merge fields like {{owner_first_name}}, {{property_address}}, {{your_name}}, {{your_phone}}, {{company_name}} (see spur://merge-variables). The plain-text version is generated from the HTML unless you pass text_body.`;

export const SMS_GUIDANCE = `SMS guidance: plain text, ideally one segment (160 GSM characters, or 70 if it uses emoji or other non-GSM characters; longer messages are billed per segment). Identify yourself, keep it conversational, and include opt-out wording ("Reply STOP to opt out") on first-touch messages. Links in texts from unverified numbers can be blocked, so give link-free fallback_body text when the body has a URL. Use merge fields like {{owner_first_name}}, {{property_address}}, {{your_name}} (see spur://merge-variables).`;

// ---------------------------------------------------------------- blank starters

/** Table-based, inline-styled email skeleton that renders in Gmail, Outlook and Apple Mail */
export function blankEmail(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>{{company_name}}</title>
<style>
  body { margin: 0; padding: 0; background: #f4f5f7; }
  table { border-collapse: collapse; }
  img { border: 0; display: block; max-width: 100%; height: auto; }
  @media (max-width: 620px) { .container { width: 100% !important; } .px { padding-left: 20px !important; padding-right: 20px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Preheader: the one-line inbox snippet shown after the subject.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="width:600px;background:#ffffff;border-radius:8px;">
        <tr>
          <td class="px" style="padding:32px 40px 8px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#111827;">{{company_name}}</td>
        </tr>
        <tr>
          <td class="px" style="padding:8px 40px 24px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#1f2937;">
            <p style="margin:0 0 16px;">Hi {{owner_first_name}},</p>
            <p style="margin:0 0 16px;"></p>
            <p style="margin:0;">{{your_name}}<br>{{company_name}} · {{your_phone}}</p>
          </td>
        </tr>
        <tr>
          <td class="px" style="padding:16px 40px 32px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#6b7280;border-top:1px solid #e5e7eb;">
            {{company_name}} · {{sender_address}}, {{sender_city}}, {{sender_state}} {{sender_zip}}<br>
            Not interested? Reply STOP and we won't email you again.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ---------------------------------------------------------------- analysis

const GSM_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"
);
const GSM_EXTENDED = new Set("^{}\\[~]|€\f");

/** Segment math the carriers bill by: GSM-7 (160 / 153 per part) or UCS-2 (70 / 67 per part) */
export function smsStats(text: string) {
  const chars = [...text];
  const gsm = chars.every(c => GSM_BASIC.has(c) || GSM_EXTENDED.has(c));
  const units = gsm ? chars.reduce((n, c) => n + (GSM_EXTENDED.has(c) ? 2 : 1), 0) : chars.length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const nonGsm = gsm ? [] : [...new Set(chars.filter(c => !GSM_BASIC.has(c) && !GSM_EXTENDED.has(c)))].slice(0, 8);
  return { characters: units, encoding: gsm ? "GSM-7" : "Unicode (UCS-2)", segments, per_segment: segments > 1 ? multi : single, non_gsm_characters: nonGsm };
}

const URL_RE = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|net|org|io|co|us|ly|me|link)\b/i;
const OPT_OUT_RE = /\bstop\b|unsubscribe|opt[ -]?out|no longer (wish|want)/i;

/** Hidden preheader text, else the start of the plain-text body, as an inbox would show it */
function inboxSnippet(html: string | null, text: string): string {
  const hidden = html?.match(/<(div|span)\b[^>]*display\s*:\s*none[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  const source = (hidden ? hidden.replace(/<[^>]+>/g, " ") : text).replace(/\s+/g, " ").trim();
  return source.length > 110 ? `${source.slice(0, 107)}…` : source;
}

export function emailWarnings(subject: string, html: string, text: string, unresolved: string[]): string[] {
  const warnings: string[] = [];
  if (!subject.trim()) warnings.push("No subject line.");
  else if (subject.length > 70) warnings.push(`Subject is ${subject.length} characters; most inboxes cut it off around 60.`);
  if (html.length > MAX_EMAIL_HTML) warnings.push(`HTML is ${html.length.toLocaleString()} characters; Spur saves up to ${MAX_EMAIL_HTML.toLocaleString()}.`);
  if (Buffer.byteLength(html) > GMAIL_CLIP_BYTES) warnings.push("Over 102 KB: Gmail will clip the message and hide the end of it.");
  if (/<script\b/i.test(html)) warnings.push("Contains <script>; email clients strip it.");
  if (/<link\b[^>]*stylesheet/i.test(html)) warnings.push("Uses an external stylesheet; most email clients ignore it, so inline the styles.");
  if (/<form\b|<input\b|<iframe\b|<video\b/i.test(html)) warnings.push("Uses forms, iframes or video, which email clients block.");
  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  if (imgs.some(tag => /\ssrc\s*=\s*["'](?!https:\/\/|data:|\{\{)/i.test(tag))) warnings.push("Some images aren't absolute https URLs and won't load in the inbox.");
  if (imgs.some(tag => !/\salt\s*=/i.test(tag))) warnings.push("Some images have no alt text (shown when images are blocked).");
  if (html && !OPT_OUT_RE.test(html) && !OPT_OUT_RE.test(text)) warnings.push('No opt-out line. Add "Reply STOP" or an unsubscribe link; commercial email needs one (CAN-SPAM).');
  if (unresolved.length) warnings.push(`Merge fields with no value in this preview: ${unresolved.map(f => `{{${f}}}`).join(", ")}. Check the spelling against spur://merge-variables, or they'll show up literally.`);
  return warnings;
}

export function smsWarnings(body: string, fallback: string | null, unresolved: string[]): string[] {
  const stats = smsStats(body);
  const warnings: string[] = [];
  if (body.length > MAX_SMS_BODY) warnings.push(`Over ${MAX_SMS_BODY} characters; Spur won't save it.`);
  if (stats.segments > 1) warnings.push(`Sends as ${stats.segments} segments (${stats.encoding}), billed per segment. Trim to ${stats.encoding === "GSM-7" ? 160 : 70} characters for one.`);
  if (stats.non_gsm_characters.length) warnings.push(`Uses ${stats.non_gsm_characters.join(" ")}, which switches the whole text to Unicode (70 characters per segment).`);
  if (URL_RE.test(body) && !fallback) warnings.push("Has a link but no fallback_body. Texts with links from unverified numbers can be blocked; add link-free fallback text.");
  if (fallback && URL_RE.test(fallback)) warnings.push("fallback_body still contains a link; it's sent when links are blocked, so remove it.");
  if (!OPT_OUT_RE.test(body)) warnings.push('No opt-out wording. Add "Reply STOP to opt out" to first-touch texts.');
  if (unresolved.length) warnings.push(`Merge fields with no value in this preview: ${unresolved.map(f => `{{${f}}}`).join(", ")}.`);
  return warnings;
}

// ---------------------------------------------------------------- Spur access

export function createMessageHelpers(spur: SpurClient) {
  const loadTemplate = async (id: string, channel: Channel | undefined, signal: AbortSignal): Promise<MessageTemplate> => {
    const template = await spur.data<MessageTemplate>("GET", `/communication/templates/${encodeURIComponent(id)}`, { signal });
    if (!template) throw new Error(`Template ${id} not found. Call spur_list_message_templates.`);
    if (template.template_type === "direct_mail") throw new Error(`Template ${id} is a direct-mail template; use the postcard or letter tools.`);
    if (channel && template.template_type !== channel) throw new Error(`Template ${id} is an ${template.template_type} template, not ${channel}.`);
    return template;
  };

  const listTemplates = async (channel: Channel | undefined, signal: AbortSignal) =>
    ((await spur.data<MessageTemplate[]>("GET", "/communication/templates", { query: { type: channel }, signal })) || []).filter(
      t => t.template_type === "email" || t.template_type === "sms"
    );

  const render = (
    content: { template_type: Channel; subject?: string | null; body?: string | null; html_content?: string | null; fallback_body?: string | null },
    ownerId: string | undefined,
    signal: AbortSignal
  ) => spur.data<RenderedContent>("POST", "/communication/templates/preview-content", { body: { ...content, owner_id: ownerId }, signal });

  const defaultSender = async (signal: AbortSignal) => {
    const senders = await spur.data<EmailSender[]>("GET", "/email-senders", { signal }).catch(() => [] as EmailSender[]);
    const active = (senders || []).filter(s => s.is_active !== false);
    return active.find(s => s.is_default) || active[0];
  };

  const ownerLabel = async (ownerId: string | undefined, signal: AbortSignal) => {
    if (!ownerId) return "Sample data";
    const owners = await spur.data<Array<{ id: string; full_name?: string | null }>>("GET", "/owners", { signal }).catch(() => []);
    return (owners || []).find(o => o.id === ownerId)?.full_name || "Selected owner";
  };

  return { loadTemplate, listTemplates, render, defaultSender, ownerLabel };
}

type Helpers = ReturnType<typeof createMessageHelpers>;

interface PreviewInput {
  channel: Channel;
  name: string;
  template_id?: string;
  subject?: string | null;
  body?: string | null;
  html?: string | null;
  fallback_body?: string | null;
}

/**
 * Renders content with merge data and builds the widget result. The rendered email HTML (images
 * inlined) goes to the widget through `_meta`, keeping it out of what the model reads.
 */
export async function messagePreview(
  helpers: Helpers,
  input: PreviewInput,
  opts: { ownerId?: string; heading: string; next?: string; signal: AbortSignal }
): Promise<CallToolResult> {
  const { signal } = opts;
  const [rendered, sender, sampleLabel] = await Promise.all([
    helpers.render({ template_type: input.channel, subject: input.subject, body: input.body, html_content: input.html, fallback_body: input.fallback_body }, opts.ownerId, signal),
    input.channel === "email" ? helpers.defaultSender(signal) : Promise.resolve(undefined),
    helpers.ownerLabel(opts.ownerId, signal)
  ]);
  const fields = rendered.variables || [];
  const unresolved = rendered.unresolved_variables || [];
  const saved = input.template_id ? { id: input.template_id, name: input.name, saved: true } : { name: input.name, saved: false };
  const savedLine = input.template_id
    ? `Saved as template_id ${input.template_id}; use it in a workflow send_${input.channel} step (spur_create_workflow or spur_set_workflow_step_template).`
    : "Not saved yet. Save it with " + (input.channel === "email" ? "spur_create_email_template" : "spur_create_sms_template") + ".";

  if (input.channel === "email") {
    const html = rendered.html_content || "";
    const subject = rendered.subject || "";
    const warnings = emailWarnings(input.subject || "", input.html || "", rendered.body, unresolved);
    const snippet = inboxSnippet(html, rendered.body);
    const from = sender ? { name: sender.display_name || sender.name || sender.email, email: sender.email } : null;
    const text = [
      opts.heading,
      bullets([
        ["Subject", subject],
        ["Inbox snippet", snippet],
        ["From", from ? `${from.name} <${from.email}>` : "no email sender set up yet (Spur → Email → Senders)"],
        ["Personalized for", sampleLabel],
        ["Merge fields", fields.length ? fields.map(f => `{{${f}}}`).join(", ") : "none"],
        ["HTML size", input.html ? `${input.html.length.toLocaleString()} characters` : "plain text only"]
      ]),
      warnings.length ? `\nChecks:\n${warnings.map(w => `- ⚠️ ${w}`).join("\n")}` : "\nChecks: no issues found.",
      "",
      savedLine,
      opts.next || "",
      PREVIEW_GUIDANCE.replace("mail piece", "email")
    ]
      .filter(Boolean)
      .join("\n");
    const result = structuredResult(text, {
      view: "message-preview",
      channel: "email",
      template: saved,
      subject,
      snippet,
      from,
      text_body: rendered.body,
      merge_fields: fields,
      unresolved_fields: unresolved,
      warnings,
      sample: { label: sampleLabel, owner_id: opts.ownerId ?? null }
    });
    return { ...result, _meta: { [MESSAGE_HTML_META]: { html: html ? await inlineImages(html) : "" } } };
  }

  const body = rendered.body || "";
  const stats = smsStats(body);
  const warnings = smsWarnings(input.body || "", input.fallback_body || null, unresolved);
  const text = [
    opts.heading,
    bullets([
      ["Message", `"${body}"`],
      ["Length", `${stats.characters} characters, ${stats.segments} segment${stats.segments === 1 ? "" : "s"} (${stats.encoding})`],
      ["Fallback (no links)", rendered.fallback_body ? `"${rendered.fallback_body}"` : undefined],
      ["Personalized for", sampleLabel],
      ["Merge fields", fields.length ? fields.map(f => `{{${f}}}`).join(", ") : "none"]
    ]),
    warnings.length ? `\nChecks:\n${warnings.map(w => `- ⚠️ ${w}`).join("\n")}` : "\nChecks: no issues found.",
    "",
    savedLine,
    opts.next || "",
    PREVIEW_GUIDANCE.replace("mail piece", "text message")
  ]
    .filter(Boolean)
    .join("\n");
  return structuredResult(text, {
    view: "message-preview",
    channel: "sms",
    template: saved,
    body,
    fallback_body: rendered.fallback_body,
    stats,
    merge_fields: fields,
    unresolved_fields: unresolved,
    warnings,
    sample: { label: sampleLabel, owner_id: opts.ownerId ?? null }
  });
}

/** Applies exact find → replace edits; each `find` must occur exactly once in its target */
function applyReplacements<T extends string>(
  targets: Record<T, string>,
  replacements: Array<{ target: T; find: string; replace: string }>
): { ok: true; values: Record<T, string> } | { ok: false; error: string } {
  const values = { ...targets };
  for (const r of replacements) {
    const source = values[r.target] ?? "";
    const count = source.split(r.find).length - 1;
    if (count !== 1) {
      return {
        ok: false,
        error: `Replacement in ${r.target} failed: "${r.find.slice(0, 80)}" occurs ${count} times (needs exactly 1). Nothing was saved. Use spur_get_message_template to see the content and pick a unique snippet.`
      };
    }
    values[r.target] = source.replace(r.find, () => r.replace);
  }
  return { ok: true, values };
}

function templateLine(t: MessageTemplate): string {
  const detail = t.template_type === "email" ? `subject "${t.subject || ""}"${t.html_content ? ", HTML" : ", plain text"}` : `"${(t.body || "").slice(0, 70)}${(t.body || "").length > 70 ? "…" : ""}"`;
  return `- **${t.template_name}** (template_id: ${t.id}) — ${detail}${t.is_default ? ", default" : ""}${t.updated_at ? `, updated ${date(t.updated_at)}` : ""}`;
}

// ---------------------------------------------------------------- tools

export function registerMessageTemplateTools({ server, spur }: ToolContext) {
  const helpers = createMessageHelpers(spur);

  /** Saves full template fields; the backend validates the whole record on update */
  const save = (method: "POST" | "PUT", path: string, record: Partial<MessageTemplate>, signal: AbortSignal) =>
    spur.data<MessageTemplate>(method, path, { body: record, signal });

  const previewSaved = (t: MessageTemplate, heading: string, signal: AbortSignal, ownerId?: string, next?: string) =>
    messagePreview(
      helpers,
      { channel: t.template_type as Channel, name: t.template_name, template_id: t.id, subject: t.subject, body: t.body, html: t.html_content, fallback_body: t.fallback_body },
      { ownerId, heading, next, signal }
    );

  server.registerTool(
    "spur_list_message_templates",
    {
      title: "List email and SMS templates",
      description: "The user's saved email and SMS templates. These are what outreach workflow send_email / send_sms steps use.",
      inputSchema: z.strictObject({ channel: z.enum(["email", "sms"]).optional().describe("Only email or only SMS templates; omit for both") }),
      annotations: READ_ONLY
    },
    async ({ channel }, ctx) => {
      const templates = await helpers.listTemplates(channel, ctx.mcpReq.signal);
      if (!templates.length) {
        return textResult(`No ${channel || "email or SMS"} templates yet. Create one with ${channel === "sms" ? "spur_create_sms_template" : "spur_create_email_template (start_from_blank=true for a ready layout)"}.`);
      }
      const byType = (type: Channel) => templates.filter(t => t.template_type === type);
      const text = [
        `# ${templates.length} message templates`,
        byType("email").length ? `\n## Email\n${byType("email").map(templateLine).join("\n")}` : "",
        byType("sms").length ? `\n## SMS\n${byType("sms").map(templateLine).join("\n")}` : ""
      ].join("\n");
      return structuredResult(text, { templates: templates.map(t => ({ id: t.id, name: t.template_name, channel: t.template_type })) });
    }
  );

  server.registerTool(
    "spur_get_message_template",
    {
      title: "Get email or SMS template",
      description: "Fetch an email template's subject, HTML and plain text, or an SMS template's text, for reading or editing. For small changes prefer the update tool's replacements over resending everything.",
      inputSchema: z.strictObject({ template_id: templateIdField }),
      annotations: READ_ONLY
    },
    async ({ template_id }, ctx) => {
      const t = await helpers.loadTemplate(template_id, undefined, ctx.mcpReq.signal);
      const header = `# ${t.template_name} (template_id: ${t.id}, ${t.template_type})${t.template_description ? `\n${t.template_description}` : ""}`;
      if (t.template_type === "sms") {
        return textResult(`${header}\n\n## Text\n${t.body || ""}${t.fallback_body ? `\n\n## Fallback (no links)\n${t.fallback_body}` : ""}`);
      }
      return textResult(
        [
          header,
          `\n## Subject\n${t.subject || ""}`,
          t.html_content ? `\n## HTML\n\`\`\`html\n${t.html_content}\n\`\`\`` : "",
          `\n## Plain text\n${t.body || ""}`
        ].join("\n")
      );
    }
  );

  registerAppTool(
    server,
    "spur_preview_message_template",
    {
      title: "Preview email or SMS template",
      description: "Show a saved email (inbox view, desktop and mobile) or SMS (phone view, segment count) rendered with sample data or a real owner's data, plus design checks. Changes nothing.",
      inputSchema: z.strictObject({ template_id: templateIdField, owner_id: ownerIdField }),
      annotations: READ_ONLY,
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Rendering preview…", "Preview")
    },
    async ({ template_id, owner_id }, ctx) => {
      const t = await helpers.loadTemplate(template_id, undefined, ctx.mcpReq.signal);
      return previewSaved(t, `${t.template_type === "email" ? "Email" : "SMS"} template **${t.template_name}** (template_id: ${t.id}).`, ctx.mcpReq.signal, owner_id);
    }
  );

  registerAppTool(
    server,
    "spur_preview_message_draft",
    {
      title: "Preview unsaved email or SMS",
      description: `Preview email HTML or SMS text before saving it: renders it with sample or real owner data and runs the design checks. Nothing is saved; iterate here, then save with spur_create_email_template / spur_create_sms_template.

${EMAIL_DESIGN_GUIDANCE}

${SMS_GUIDANCE}`,
      inputSchema: z.strictObject({
        channel: z.enum(["email", "sms"]).describe("Whether the draft is an email or an SMS"),
        subject: z.string().max(500).optional().describe("Email subject"),
        html: z.string().max(200_000).optional().describe("Email HTML"),
        text: z.string().max(10_000).optional().describe("SMS text, or the email's plain-text version"),
        fallback_body: z.string().max(MAX_SMS_BODY).optional().describe("SMS only: link-free text sent if links are blocked"),
        owner_id: ownerIdField
      }),
      annotations: READ_ONLY,
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Rendering preview…", "Draft preview")
    },
    async ({ channel, subject, html, text, fallback_body, owner_id }, ctx) => {
      if (channel === "email" && !html && !text) return { ...textResult("Pass html (or text for a plain-text email)."), isError: true };
      if (channel === "sms" && !text) return { ...textResult("Pass the SMS text."), isError: true };
      return messagePreview(
        helpers,
        { channel, name: "Draft", subject: subject ?? "", body: text, html: channel === "email" ? html : null, fallback_body: channel === "sms" ? fallback_body : null },
        { ownerId: owner_id, heading: `Draft ${channel === "email" ? "email" : "SMS"} preview (not saved).`, signal: ctx.mcpReq.signal }
      );
    }
  );

  registerAppTool(
    server,
    "spur_create_email_template",
    {
      title: "Create email template",
      description: `Save a new email template and show its inbox preview. Ways to start:
- From blank: start_from_blank=true gives a tested 600px responsive layout with greeting, signature and a compliant footer; pass html to replace it.
- Redesign: base_template_id copies one of the user's email templates.
- From scratch: pass html (or only text_body for a plain-text email).
The saved template can then be used by outreach workflows (spur_create_workflow / spur_set_workflow_step_template).

${EMAIL_DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Template name shown in Spur"),
        subject: z.string().min(1).max(500).optional().describe("Required unless copying a template"),
        start_from_blank: z.boolean().optional().describe("true = start from Spur's responsive, compliant blank email layout"),
        base_template_id: templateIdField.optional().describe("Copy this email template as the starting point"),
        html: z.string().max(MAX_EMAIL_HTML).optional().describe("Full email HTML; merge fields like {{owner_first_name}} are filled per recipient"),
        text_body: z.string().max(10_000).optional().describe("Plain-text version; generated from the HTML when omitted"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never sent to owners"),
        is_default: z.boolean().optional().describe("true = make this the user's default template for its channel").describe("Make this the user's default email template")
      }),
      annotations: WRITE,
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Saving email template…", "Email template saved")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      if (args.start_from_blank && args.base_template_id) return { ...textResult("Use either start_from_blank or base_template_id, not both."), isError: true };
      const base = args.base_template_id ? await helpers.loadTemplate(args.base_template_id, "email", signal) : undefined;
      const html = args.html ?? base?.html_content ?? (args.start_from_blank ? blankEmail() : null);
      const subject = args.subject ?? base?.subject;
      if (!subject) return { ...textResult("Pass a subject line."), isError: true };
      if (!html && !args.text_body && !base?.body) return { ...textResult("Pass html, text_body, a base_template_id, or start_from_blank=true."), isError: true };
      // A copied hand-written plain-text part only carries over when the HTML does too
      const body = args.text_body ?? (base && args.html === undefined ? base.body : "") ?? "";
      const created = await save(
        "POST",
        "/communication/templates",
        {
          template_name: args.name,
          template_description: args.description ?? base?.template_description ?? null,
          template_type: "email",
          subject,
          body,
          html_content: html,
          is_default: args.is_default ?? false,
          is_active: true
        },
        signal
      );
      const blankOnly = args.start_from_blank && !args.html;
      return previewSaved(
        created,
        `Created email template **${created.template_name}** (template_id: ${created.id})${blankOnly ? " from the blank layout" : base ? ` from "${base.template_name}"` : ""}.`,
        signal,
        undefined,
        blankOnly ? "The body paragraph is empty. Write it with spur_update_email_template (replacements on the empty <p>, or full html)." : undefined
      );
    }
  );

  registerAppTool(
    server,
    "spur_update_email_template",
    {
      title: "Edit email template",
      description: `Edit one of the user's email templates and show the updated inbox preview. For tweaks pass replacements (exact find → replace in "html", "subject" or "text"); to redesign pass full html. When the HTML changes, the plain-text version is regenerated unless it was hand-written or you pass text_body. Workflows using this template send the new version from their next step.

Example: replacements=[{target:"html", find:"<p style=\\"margin:0 0 16px;\\"></p>", replace:"<p style=\\"margin:0 0 16px;\\">I'd like to make a cash offer on {{property_address}}.</p>"}]

${EMAIL_DESIGN_GUIDANCE}`,
      inputSchema: z.strictObject({
        template_id: templateIdField,
        name: z.string().min(1).max(255).optional().describe("New template name"),
        subject: z.string().min(1).max(500).optional().describe("New subject line"),
        html: z.string().max(MAX_EMAIL_HTML).optional().describe("Full replacement HTML"),
        text_body: z.string().max(10_000).optional().describe("Full replacement plain-text version"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never sent to owners"),
        is_default: z.boolean().optional().describe("true = make this the user's default template for its channel"),
        replacements: z
          .array(z.strictObject({ target: z.enum(["html", "subject", "text"]).describe("Which part to edit"), find: z.string().min(1).describe("Exact text that occurs once in that part"), replace: z.string() }))
          .max(30)
          .optional()
          .describe("Small edits applied in order instead of resending the full content")
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Updating email template…", "Email template updated")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      const current = await helpers.loadTemplate(args.template_id, "email", signal);
      const edited = applyReplacements(
        { html: args.html ?? current.html_content ?? "", subject: args.subject ?? current.subject ?? "", text: args.text_body ?? current.body ?? "" },
        args.replacements || []
      );
      if (!edited.ok) return { ...textResult(edited.error), isError: true };
      const { html, subject } = edited.values;
      let text = edited.values.text;
      const htmlChanged = html !== (current.html_content ?? "");
      const textEdited = args.text_body !== undefined || (args.replacements || []).some(r => r.target === "text");
      if (htmlChanged && !textEdited && current.html_content) {
        // Regenerate only if the stored text was the generated one, so hand-written text survives
        const generated = await helpers.render({ template_type: "email", html_content: current.html_content, body: "" }, undefined, signal).catch(() => undefined);
        if (generated && normalizeWs(current.body) === normalizeWs(generated.source_body)) text = "";
      } else if (htmlChanged && !textEdited && !current.html_content) {
        text = "";
      }

      const record = {
        template_name: args.name ?? current.template_name,
        template_description: args.description ?? current.template_description ?? null,
        template_type: "email" as const,
        subject,
        body: text,
        html_content: html || null,
        is_default: args.is_default ?? current.is_default ?? false,
        is_active: current.is_active ?? true
      };
      const unchanged =
        record.template_name === current.template_name &&
        record.template_description === (current.template_description ?? null) &&
        subject === (current.subject ?? "") &&
        !htmlChanged &&
        text === (current.body ?? "") &&
        record.is_default === (current.is_default ?? false);
      if (unchanged) return textResult("Nothing to change: the template already matches.");
      const updated = await save("PUT", `/communication/templates/${encodeURIComponent(current.id)}`, record, signal);
      const changed = [
        record.template_name !== current.template_name && "name",
        subject !== (current.subject ?? "") && "subject",
        htmlChanged && "HTML",
        (text !== (current.body ?? "") || (htmlChanged && text === "")) && (text === "" ? "plain text (regenerated)" : "plain text"),
        record.template_description !== (current.template_description ?? null) && "description",
        record.is_default !== (current.is_default ?? false) && "default"
      ].filter(Boolean);
      return previewSaved(updated, `Updated **${updated.template_name}** (template_id: ${updated.id}): ${changed.join(", ")}.`, signal);
    }
  );

  registerAppTool(
    server,
    "spur_create_sms_template",
    {
      title: "Create SMS template",
      description: `Save a new SMS template and show its phone preview with segment count and checks. The saved template can then be used by outreach workflows (spur_create_workflow / spur_set_workflow_step_template).

${SMS_GUIDANCE}`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Template name shown in Spur"),
        text: z.string().min(1).max(MAX_SMS_BODY).describe("SMS body; merge fields like {{owner_first_name}} are filled per recipient"),
        fallback_body: z.string().max(MAX_SMS_BODY).optional().describe("Link-free version sent if a link gets the text blocked"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never sent to owners"),
        is_default: z.boolean().optional().describe("true = make this the user's default template for its channel")
      }),
      annotations: WRITE,
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Saving SMS template…", "SMS template saved")
    },
    async (args, ctx) => {
      const created = await save(
        "POST",
        "/communication/templates",
        {
          template_name: args.name,
          template_description: args.description ?? null,
          template_type: "sms",
          body: args.text,
          fallback_body: args.fallback_body ?? null,
          is_default: args.is_default ?? false,
          is_active: true
        },
        ctx.mcpReq.signal
      );
      return previewSaved(created, `Created SMS template **${created.template_name}** (template_id: ${created.id}).`, ctx.mcpReq.signal);
    }
  );

  registerAppTool(
    server,
    "spur_update_sms_template",
    {
      title: "Edit SMS template",
      description: `Edit one of the user's SMS templates and show the updated preview. Pass full text / fallback_body, or replacements (exact find → replace in "text" or "fallback"). Pass fallback_body="" to remove the fallback.

${SMS_GUIDANCE}`,
      inputSchema: z.strictObject({
        template_id: templateIdField,
        name: z.string().min(1).max(255).optional().describe("New template name"),
        text: z.string().min(1).max(MAX_SMS_BODY).optional().describe("Full replacement SMS body"),
        fallback_body: z.string().max(MAX_SMS_BODY).optional().describe("Link-free text sent instead when links are blocked; \"\" removes it"),
        description: z.string().max(1000).optional().describe("Internal note about the template; never sent to owners"),
        is_default: z.boolean().optional().describe("true = make this the user's default template for its channel"),
        replacements: z
          .array(z.strictObject({ target: z.enum(["text", "fallback"]).describe("Which part to edit"), find: z.string().min(1).describe("Exact text that occurs once in that part"), replace: z.string() }))
          .max(30)
          .optional()
          .describe("Small edits applied in order instead of resending the full content")
      }),
      annotations: { ...WRITE, idempotentHint: true },
      _meta: widgetMeta(MESSAGE_PREVIEW_URI, "Updating SMS template…", "SMS template updated")
    },
    async (args, ctx) => {
      const signal = ctx.mcpReq.signal;
      const current = await helpers.loadTemplate(args.template_id, "sms", signal);
      const edited = applyReplacements(
        { text: args.text ?? current.body ?? "", fallback: args.fallback_body ?? current.fallback_body ?? "" },
        args.replacements || []
      );
      if (!edited.ok) return { ...textResult(edited.error), isError: true };
      const record = {
        template_name: args.name ?? current.template_name,
        template_description: args.description ?? current.template_description ?? null,
        template_type: "sms" as const,
        body: edited.values.text,
        fallback_body: edited.values.fallback || null,
        is_default: args.is_default ?? current.is_default ?? false,
        is_active: current.is_active ?? true
      };
      if (
        record.template_name === current.template_name &&
        record.body === current.body &&
        record.fallback_body === (current.fallback_body ?? null) &&
        record.template_description === (current.template_description ?? null) &&
        record.is_default === (current.is_default ?? false)
      ) {
        return textResult("Nothing to change: the template already matches.");
      }
      const updated = await save("PUT", `/communication/templates/${encodeURIComponent(current.id)}`, record, signal);
      return previewSaved(updated, `Updated SMS template **${updated.template_name}** (template_id: ${updated.id}).`, signal);
    }
  );

  server.registerTool(
    "spur_delete_message_template",
    {
      title: "Delete email or SMS template",
      description: "Delete one of the user's email or SMS templates. Workflow steps that use it will fail until they get another template, so check spur_list_workflows and confirm with the user first.",
      inputSchema: z.strictObject({ template_id: templateIdField, confirm: confirmField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ template_id }, ctx) => {
      const t = await helpers.loadTemplate(template_id, undefined, ctx.mcpReq.signal);
      await spur.request("DELETE", `/communication/templates/${encodeURIComponent(template_id)}`, { signal: ctx.mcpReq.signal });
      return textResult(`Deleted ${t.template_type} template "${t.template_name}" (${template_id}).`);
    }
  );

  server.registerTool(
    "spur_send_test_email",
    {
      title: "Send test email to yourself",
      description: "Send an email template, filled with sample data (or one owner's data), to the user's own Spur account email from their email sender, to check it in a real inbox. Never goes to owners. Confirm with the user first.",
      inputSchema: z.strictObject({
        template_id: templateIdField,
        owner_id: ownerIdField,
        sender_id: z.string().optional().describe("Email sender to send from; defaults to the user's default sender"),
        confirm: confirmField
      }),
      annotations: { ...OUTWARD, destructiveHint: false }
    },
    async ({ template_id, owner_id, sender_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const [t, sender] = await Promise.all([helpers.loadTemplate(template_id, "email", signal), sender_id ? Promise.resolve({ id: sender_id }) : helpers.defaultSender(signal)]);
      if (!sender) return { ...textResult("No email sender is set up. Add and verify one in Spur → Email → Senders first."), isError: true };
      const rendered = await helpers.render({ template_type: "email", subject: t.subject, body: t.body, html_content: t.html_content }, owner_id, signal);
      const result = await spur.data<{ recipient?: string }>("POST", "/email-senders/send-test", {
        body: { sender_id: sender.id, subject: rendered.subject, html: rendered.html_content, text: rendered.body, template_id: t.id, template_kind: "communication" },
        signal
      });
      return textResult(`Sent a test of "${t.template_name}" to ${result?.recipient || "your account email"}. Check that inbox (and spam).`);
    }
  );
}

const normalizeWs = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
