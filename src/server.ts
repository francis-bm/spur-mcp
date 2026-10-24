/**
 * Server factory: a fresh McpServer per request (HTTP) or per connection (stdio), bound to one Spur session.
 */
import { McpServer } from "@modelcontextprotocol/server";
import type { Sealer } from "./auth/seal.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { registerResourcesAndPrompts } from "./resources.js";
import { SpurApiError, type SpurClient } from "./spurApi.js";
import { registerAutomationTools } from "./tools/automations.js";
import { registerBillingTools } from "./tools/billing.js";
import { registerImageTools } from "./tools/images.js";
import { registerLetterTools } from "./tools/letters.js";
import { registerListTools } from "./tools/lists.js";
import { registerMessageTemplateTools } from "./tools/messageTemplates.js";
import { registerOutreachTools } from "./tools/outreach.js";
import { registerOwnerTools } from "./tools/owners.js";
import { registerPostcardTools } from "./tools/postcards.js";
import { registerPropertyTools } from "./tools/properties.js";
import { registerQrCodeTools } from "./tools/qrCodes.js";
import { registerReportingTools } from "./tools/reporting.js";
import { registerSearchFetchTools } from "./tools/searchFetch.js";
import { registerWidgets } from "./widgets.js";

const INSTRUCTIONS = `Spur is a real-estate prospecting platform: find properties, skip-trace owners, and reach them by SMS, email and direct mail.

Typical flow: spur_search_properties → spur_save_properties → spur_enrich (owner contacts) → outreach (spur_draft_message, spur_send_sms, workflows) or direct mail.

Direct mail design: postcards come in 6x4, 6x9 and 6x11; letters are US Letter in one of two types, top_first_page (address shows through the envelope window, so the top 3.15in stays empty) or insert_blank_page (Spur adds an address page, so the letter keeps the full page). Start from blank (start_from_blank=true) or redesign an existing template (base_template_id, including Spur gallery designs) with spur_create_postcard_template / spur_create_letter_template, refine with the matching update tool, then mail: spur_preview_postcard_campaign → spur_send_postcards, or spur_preview_letter_campaign → spur_send_letters.

QR codes on postcards: by default, design every postcard back with an empty QR code box (<div class="qr-box">) in the message area, unless the user says they don't want a QR code. Then fill it with spur_add_postcard_qr_code (never hand-write QR markup). Manage tracked codes with spur_list_qr_codes / spur_create_qr_code / spur_update_qr_code / spur_delete_qr_code; if none fits, ask the user where scans should go. See who scanned with spur_get_qr_code_activity.

The user's own images (logos, headshots, property photos): spur_list_images gives their saved images with public URLs to use in postcard, letter and email HTML. To add one from their device, including an image they attached to the chat (attachments don't reach Spur), call spur_upload_image and let them drop it in; for a public link, spur_save_image. Prefer the user's saved images over stock photos when they fit.

Email and SMS: design templates with spur_create_email_template (start_from_blank=true gives a responsive, compliant layout) or spur_create_sms_template, refine with the matching update tool, and check them with spur_preview_message_template (inbox/phone view, sample or real owner data) or spur_preview_message_draft before saving; spur_send_test_email sends one to the user's own inbox. Saved templates drive outreach workflows: spur_create_workflow builds a sequence (send_email / send_sms / send_direct_mail / wait steps) as an inactive draft, spur_set_workflow_step_template swaps a step's template, then spur_set_workflow_active and spur_enroll_owners_in_workflow start it after approval.

Property research: translate the user's criteria into structured filters (spur_parse_search_query previews this for free), and use event filters for change or motivation signals (price drops, back on market, stale, distress stages, FSBO, equity gaps). If a search comes back thin, read the filter/event notes it returns and relax one constraint at a time instead of guessing. Recurring research belongs in spur_create_search_automation with the same filters.

Paying for Spur: when the user wants to add funds, buy credits, upgrade or compare plans, or a tool fails with "Billing limit reached", call spur_show_billing_options. It renders one-click Pay and Upgrade buttons. Or go straight to spur_top_up_wallet (amount_usd) or spur_change_plan (plan_id, billing_interval) when the user named what they want. Both return a Stripe checkout link: share it, and once the user says they paid, call spur_check_payment with its session_id. When a send is short on funds, suggest a top-up that covers the shortfall (round up to $25, $50 or $100) and offer spur_set_auto_recharge so it doesn't happen again.

Rules:
- Tools that spend money or contact people need explicit user approval for that exact action (confirm=true). Never assume it.
- Postcards and letters always go through their preview tool first (spur_preview_postcard_campaign / spur_preview_letter_campaign); send only with that preview's confirmation_token after the user approves.
- Check spur_get_billing_summary before large sends or enrichment batches.
- Never ask for card numbers in the chat; payment happens only on Stripe's page. Switching an existing paid subscription and turning on auto-recharge charge the saved card, so they need confirm=true after explicit approval.
- Refer to properties and owners by address/name, not ids, when talking to the user.
- Spur tools are the only source for the user's templates, postcards, properties and owners. Never supplement them with web search, image search or outside examples (e.g. Etsy, Canva, Pinterest), and never invent details a tool didn't return.
- When a tool renders a preview widget, that widget is the preview. Don't add other images or mockups, and don't describe the design beyond what the tool result says.`;

/**
 * Wraps every tool handler so unexpected failures are reported to the Spur team. SpurApiErrors are
 * skipped: the backend already reports its own 5xx responses, and 4xx are expected user errors.
 */
function reportToolErrors(server: McpServer, spur: SpurClient): void {
  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  server.registerTool = ((name: string, toolConfig: unknown, handler: (...args: unknown[]) => unknown) =>
    registerTool(name, toolConfig, async (...args: unknown[]) => {
      try {
        return await handler(...args);
      } catch (error) {
        if (!(error instanceof SpurApiError)) {
          const err = error instanceof Error ? error : new Error(String(error));
          await spur.reportError({ message: err.message, stack: err.stack, location: `MCP tool ${name}` });
        }
        throw error;
      }
    })) as typeof server.registerTool;
}

export function createSpurServer(spur: SpurClient, sealer: Sealer): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION, title: "Spur" }, { instructions: INSTRUCTIONS });
  const ctx = { server, spur, sealer };
  reportToolErrors(server, spur);

  registerWidgets(server);
  registerPropertyTools(ctx);
  registerOwnerTools(ctx);
  registerListTools(ctx);
  registerOutreachTools(ctx);
  registerMessageTemplateTools(ctx);
  registerPostcardTools(ctx);
  registerQrCodeTools(ctx);
  registerImageTools(ctx);
  registerLetterTools(ctx);
  registerReportingTools(ctx);
  registerBillingTools(ctx);
  registerAutomationTools(ctx);
  registerSearchFetchTools(ctx);
  registerResourcesAndPrompts(server);

  return server;
}
