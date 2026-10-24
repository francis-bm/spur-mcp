/**
 * Static reference resources and slash-command prompts.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { blankEmail } from "./tools/messageTemplates.js";

const MERGE_VARIABLES = `# Spur merge fields

Use these as {{field}} in postcards, letters, email and SMS. Spur fills them per recipient.

## Owner / recipient
- {{owner_first_name}}, {{owner_last_name}}, {{owner_full_name}}, {{owner_company}}
- {{recipient_address_line1}}, {{recipient_city}}, {{recipient_state}}, {{recipient_postal_code}}

## Property
- {{property_address}}, {{property_city}}, {{property_state}}, {{property_zip}}
- {{property_bedrooms}}, {{property_bathrooms}}, {{property_sqft}}, {{property_amount}}

## You (from Spur profile and return address)
- {{your_name}}, {{your_phone}}, {{your_email}}
- {{company_name}}, {{company_phone}}, {{company_website}}
- {{sender_address}}, {{sender_city}}, {{sender_state}}, {{sender_zip}}

## AI and tracking
- {{ai_personalized_intro}}: one-sentence personalized opener generated per owner
- {{qrUrl}}: per-recipient tracking QR image (postcards). Don't type it: spur_add_postcard_qr_code adds it linked to a QR code, which is what makes Spur mint a code per recipient. Unlinked, it prints blank.

Unknown fields render as empty text, so preview before sending.`;

const POSTCARD_GUIDE = `# Postcard design guide

Sizes (trim, landscape): 6x4 → 6"×4", 6x9 → 9"×6", 6x11 → 11"×6". Add 0.125" bleed on every edge.
Spur's built-in templates are authored at 300 px/inch including bleed: 6x4 → 1875×1275 px, 6x9 → 2775×1875 px, 6x11 → 3375×1875 px.

Rules
- Full HTML documents with inline <style>; no JavaScript, no external CSS frameworks.
- Fixed pixel sizing on html, body and a root .postcard element matching the bleed size.
- Back side USPS clear zone, measured from the bleed edges. Spur paints these white when printing, so anything designed there is covered:
  - Postage: 1.25"×1.25" in the top-right corner.
  - Address block: 3.5"×2", 0.5" from the right edge and 1.35" from the top.
  - USPS barcode: 4.75"×0.625" along the bottom-right edge (it reaches further left than the address block).
  Keep text, logos, photos and QR codes out of all of them; a background color or texture under them is fine. Put the message left of the address block and above the barcode strip. The preview widget checks the rendered back against these zones and reports anything inside them.
- Keep text 0.125" inside the trim edge. Body copy ≥ 30 px at 300 ppi (≈ 7 pt).
- Images must be absolute https URLs. Use the user's own images when they fit: spur_list_images for saved ones, spur_upload_image to add one from their device, spur_save_image for a link.
- Use merge fields from spur://merge-variables for personalization.

QR codes
- Default: every back includes an empty square <div class="qr-box"> (≥ 0.75", e.g. 225×225 px) in the message area, unless the user says they don't want a QR code. Design the layout around it.
- After saving, fill it with spur_add_postcard_qr_code (position="auto"). That writes the placeholder Spur's editor uses, linked to one of the user's QR codes (spur_list_qr_codes / spur_create_qr_code; ask the user where scans should go if none fits). Each mailed card gets its own code, so scans are tracked per recipient. An unfilled box prints empty, and previews say so.
- Without a box, the QR goes in a corner of the message area (bottom-right by default), clear of the USPS zones, but it may cover text.
- Give it a light background and dark modules, and a short call to action next to it ("Scan for your home's value").

Starting points
- Blank: spur_create_postcard_template start_from_blank=true, size=… gives an empty canvas at the right pixel size, with the back's message column already kept clear of the address area.
- Redesign: base_template_id copies any template (yours, a Spur default or a gallery id from spur_list_postcard_templates). Passing a different size rescales the copy when printed; check the preview.

Workflow: create (blank or copy) → design with spur_update_postcard_template (full HTML or replacements) → optional spur_add_postcard_qr_code → spur_preview_postcard_campaign → user approves → spur_send_postcards.`;

const LETTER_GUIDE = `# Letter design guide

Letters print on US Letter (8.5"×11"), one page, mailed in a #10 envelope. Pick the letter type first:

- top_first_page: the return and recipient addresses print in the top 3.15" of page 1 and show through the envelope window. Leave that band empty (an empty <div class="address-zone" style="height:3.15in">, or a slim ≤0.8" letterhead strip the address can sit over). Body ≈ 3–4 short paragraphs.
- insert_blank_page: Spur inserts a separate address page in front, so the letter starts at the top of its page. Letterhead up to 1.8", body up to ~400 words. Costs one extra page per letter.

Rules
- Full HTML document with inline <style>, "@page { size: 8.5in 11in; margin: 0; }", no JavaScript.
- One root <div class="letter"> 8.5in wide (class page/sheet/container/wrapper also works). No box-shadow, border-radius, transforms or animations on it.
- px, in or pt units only: no vh/vw on layout. No manual page breaks; content must fit one page (the preview warns when it spills).
- Print colors: "-webkit-print-color-adjust: exact; print-color-adjust: exact" on *.
- Images must be absolute https URLs (the user's saved images from spur_list_images, or new ones via spur_upload_image / spur_save_image). Use merge fields from spur://merge-variables.

Starting points
- Blank: spur_create_letter_template start_from_blank=true, letter_type=… gives a one-page skeleton laid out for that type.
- Redesign: base_template_id copies any template (yours, a Spur default or a gallery id from spur_list_letter_templates), keeping its letter type unless you pass letter_type.

Workflow: create (blank or copy) → design with spur_update_letter_template (full html or replacements) → spur_preview_letter_campaign → user approves → spur_send_letters.`;


const EMAIL_GUIDE = `# Email design guide

Spur sends each email as HTML plus a plain-text part (generated from the HTML unless you write one). Design for the narrowest common client, not a browser.

Layout
- Full HTML document. Outer table 100% wide with a background color; inner content table 600px wide (class="container", width="600"), centered.
- Tables for layout (role="presentation", cellpadding="0", cellspacing="0"); no flexbox, grid, floats or position.
- Inline styles on every element that needs them. A small <style> in <head> is fine for resets and one @media (max-width: 620px) block that makes .container 100% wide; Gmail keeps head styles, many others drop them.
- Web-safe font stacks (Arial, Helvetica, Georgia, "Segoe UI"); web fonts only as progressive enhancement.
- No JavaScript, forms, iframes, video, external stylesheets or CSS background images for content.

Content
- A hidden preheader right after <body> (<div style="display:none;max-height:0;overflow:hidden;opacity:0;">…</div>) sets the inbox snippet next to the subject.
- Subject under ~60 characters; personalize with {{owner_first_name}} or {{property_address}} sparingly.
- Images: absolute https URLs, width attribute, alt text, display:block. PNG or JPG, not SVG. The user's saved images (spur_list_images) are hosted and safe to use; add new ones with spur_upload_image or spur_save_image. Keep key text as live text, not inside images.
- Buttons: a table cell with background color and an <a> styled inline (padding, color, text-decoration:none), at least 44px tall.
- Footer: who you are ({{company_name}}), a postal address ({{sender_address}}, {{sender_city}}, {{sender_state}} {{sender_zip}}) and an opt-out line ("Reply STOP" or an unsubscribe link). Commercial email needs both (CAN-SPAM).
- Under 50,000 characters of HTML (Spur's limit) and well under 102 KB (Gmail clips longer messages).
- Merge fields from spur://merge-variables; the preview flags any that come out empty.

Starting points
- Blank: spur_create_email_template start_from_blank=true (the skeleton below).
- Redesign: base_template_id copies one of the user's email templates.
- Draft: spur_preview_message_draft renders HTML without saving.

Workflow: design → spur_preview_message_draft or create → spur_update_email_template (replacements or full html) → spur_send_test_email → use it in a workflow (spur_create_workflow / spur_set_workflow_step_template).

## Blank layout
\`\`\`html
${blankEmail()}
\`\`\``;

export function registerResourcesAndPrompts(server: McpServer) {
  server.registerResource(
    "spur-merge-variables",
    "spur://merge-variables",
    { title: "Merge fields", description: "Every {{merge_field}} Spur fills in for postcards, letters, email and SMS", mimeType: "text/markdown" },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: MERGE_VARIABLES }] })
  );

  server.registerResource(
    "spur-postcard-guide",
    "spur://postcard-design-guide",
    { title: "Postcard design guide", description: "Sizes, bleed, address-block safe zone and HTML rules for Spur postcards", mimeType: "text/markdown" },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: POSTCARD_GUIDE }] })
  );

  server.registerResource(
    "spur-letter-guide",
    "spur://letter-design-guide",
    { title: "Letter design guide", description: "Letter types (Top First Page, Insert Blank Page), address area and HTML rules for Spur letters", mimeType: "text/markdown" },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: LETTER_GUIDE }] })
  );

  server.registerResource(
    "spur-email-guide",
    "spur://email-design-guide",
    { title: "Email design guide", description: "Layout, client-safe HTML, preheader, footer compliance and the blank layout for Spur email templates", mimeType: "text/markdown" },
    async uri => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: EMAIL_GUIDE }] })
  );

  server.registerPrompt(
    "spur_deal_hunt",
    {
      title: "Deal hunt",
      description: "Find, shortlist and save properties in a market",
      argsSchema: z.object({
        location: z.string().describe('City/state or ZIP, e.g. "Dallas, TX"'),
        criteria: z.string().optional().describe('e.g. "3+ bed under $2,000/mo, owned 10+ years"')
      })
    },
    async ({ location, criteria }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Find promising properties in ${location}${criteria ? ` matching: ${criteria}` : ""}. First call spur_parse_search_query on my criteria and show me the filters and events you'll use; adjust anything that doesn't fit, then run spur_search_properties with structured filters (and query only for qualitative intent). If results are thin, use the notes in the result to relax one filter at a time and say what you changed. Give me a shortlist of the best 5 with one line each on why, citing any events they matched. Ask before saving, and ask again before any skip tracing (it costs credits).`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_motivated_seller_research",
    {
      title: "Motivated seller research",
      description: "Find owners likely to sell using listing events (price drops, back on market, stale, distress, FSBO) and owner signals",
      argsSchema: z.object({
        location: z.string().describe('City/state or ZIP, e.g. "Houston, TX"'),
        criteria: z.string().optional().describe('Extra constraints, e.g. "single family under $400k built before 1990"'),
        days: z.string().optional().describe("Lookback window in days (default 14)")
      })
    },
    async ({ location, criteria, days }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Research motivated sellers in ${location}${criteria ? ` (${criteria})` : ""} over the last ${days || "14"} days.
1. Preview the criteria with spur_parse_search_query and tell me the filters you'll keep.
2. Run spur_search_properties with listing_status="forSale", those filters and events=["price_drop","back_on_market","stale_listing","agent_to_fsbo","fsbo","preforeclosure","auction"], event_within_days=${days || "14"}.
3. Run a second search with the same filters plus only_absentee=true and events=["equity_gap","price_below_assessed"] for owners sitting on equity.
4. Rank the combined results: more events and stronger distress (auction > foreclosure > pre-foreclosure > price drop > stale) rank higher; say which events each property hit and the numbers behind them.
5. If change events show nothing because this is the first look at the area, say so and offer to set up a daily spur_create_search_automation with the same filters so changes are caught from now on.
Shortlist the top 10. Don't save, enrich or contact anyone until I approve.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_follow_up_hot_leads",
    {
      title: "Follow up hot leads",
      description: "Triage SMS replies and draft follow-ups",
      argsSchema: z.object({})
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Check my unread SMS replies with spur_list_sms_conversations (unread_only). Group them into hot leads, maybe later, not interested, and wrong number. For each hot lead, read the thread and draft a reply. Don't send anything until I approve each one."
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_postcard_campaign",
    {
      title: "Postcard campaign",
      description: "Pick or design a postcard, preview it with real owners, and mail it after approval",
      argsSchema: z.object({
        audience: z.string().describe('Who to mail, e.g. "owners in my Austin Absentee list" or "all enriched owners in 78704"'),
        message: z.string().optional().describe("What the card should say or the vibe you want")
      })
    },
    async ({ audience, message }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to mail postcards to ${audience}.${message ? ` Message: ${message}.` : ""} Show me my postcard templates (spur_list_postcard_templates) and suggest one, or design a new one following spur://postcard-design-guide. Then find the owners, run spur_preview_postcard_campaign, and wait for my approval before sending.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_letter_campaign",
    {
      title: "Letter campaign",
      description: "Pick or design a letter (Top First Page or Insert Blank Page), preview it with real owners, and mail it after approval",
      argsSchema: z.object({
        audience: z.string().describe('Who to mail, e.g. "absentee owners in 78704"'),
        message: z.string().optional().describe("What the letter should say or the tone you want")
      })
    },
    async ({ audience, message }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `I want to mail letters to ${audience}.${message ? ` Message: ${message}.` : ""} Ask whether I want a Top First Page letter (address shows through the envelope window) or an Insert Blank Page letter (full-page design plus an address page). Show my letter templates (spur_list_letter_templates) and suggest one to redesign, or start from blank following spur://letter-design-guide. Then find the owners, run spur_preview_letter_campaign, and wait for my approval before sending.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_outreach_sequence",
    {
      title: "Outreach sequence",
      description: "Design email and SMS templates, preview them, and assemble them into an outreach workflow",
      argsSchema: z.object({
        goal: z.string().describe('What the sequence is for, e.g. "first touch to absentee owners offering a cash purchase"'),
        channels: z.string().optional().describe('e.g. "text, then email two days later, then a postcard"')
      })
    },
    async ({ goal, channels }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Build me an outreach sequence: ${goal}.${channels ? ` Channels and timing: ${channels}.` : ""} First check my existing templates (spur_list_message_templates) and reuse what fits. For new emails follow spur://email-design-guide: start from spur_create_email_template start_from_blank=true, write the copy, and show me the inbox preview. For texts use spur_create_sms_template and keep each to one segment with opt-out wording. Fix anything the preview checks flag. Then assemble the steps with spur_create_workflow (it stays an inactive draft) and show me the result. Don't send tests, activate the workflow or enroll anyone until I approve.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "spur_weekly_review",
    {
      title: "Weekly review",
      description: "Summarize the week: spend, campaigns, mail delivery and replies",
      argsSchema: z.object({})
    },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Give me a weekly Spur review: billing and remaining credits (spur_get_billing_summary), campaign progress (spur_list_campaigns), direct mail delivery (spur_get_direct_mail_analytics), outreach results (spur_get_outreach_report for the last 7 days) and unread replies. End with three suggested next actions."
          }
        }
      ]
    })
  );
}
