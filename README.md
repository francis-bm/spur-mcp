# Spur MCP server

Connects Spur to **Claude** and **ChatGPT**. Users sign in with their Spur account and can then search properties, skip-trace owners, run outreach, and design email and SMS templates and the outreach workflows that send them, and design and mail postcards and letters from the chat. Interactive widgets render inline:

- **Property explorer**: a price-pin map with property cards, plus Save, Details and Find owner buttons.
- **Property detail**: the same widget showing a single property.
- **Postcard preview**: front and back artwork filled with a real recipient's data, the recipient count and the cost, plus a Send button that asks for confirmation first.
- **Billing**: wallet balance with one-click top-ups ($25/$50/$100 or any amount), plan cards with a monthly/annual toggle and Upgrade buttons, auto-recharge, and a Stripe hand-off with an "I've paid: check" button.
- **Email and SMS preview**: an email as it lands in an inbox (subject, sender, preheader snippet; desktop, mobile and plain-text views) or a text as a phone bubble with its segment count, plus merge fields and design checks.

The widgets follow the [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. Claude renders it natively, and ChatGPT's Apps SDK uses it as its widget format, so one implementation serves both hosts. The resources also carry ChatGPT's legacy `openai/*` metadata keys.

```
Claude / ChatGPT ──OAuth──▶ spur-mcp-server (/mcp) ──user's Spur JWT──▶ Spur backend (/api/*)
                               │
                               └─ ui://spur/*.html widgets (served as MCP resources)
```

The server keeps no data of its own. Every tool calls the existing Spur REST API with the signed-in user's own Spur session. That means Spur's RBAC, per-user data isolation, billing checks and audit logs apply to every call unchanged. All Spur calls carry `X-Spur-Client: mcp`.

## Tools

| Area | Tools | Notes |
|---|---|---|
| Find deals | `spur_search_properties` 🗺, `spur_get_property` 🗺, `spur_save_properties`, `spur_list_saved_properties` 🗺, `spur_get_property_stats` | Search uses 1 property-search credit |
| Owners | `spur_find_owners`, `spur_get_owner`, `spur_enrich` 💲 | Enrichment = skip-trace credits |
| Lists | `spur_list_property_lists`, `spur_create_property_list`, `spur_add_properties_to_list` | |
| Outreach | `spur_draft_message`, `spur_list_workflows`, `spur_get_workflow`, `spur_create_workflow`, `spur_set_workflow_step_template`, `spur_set_workflow_active` 💲, `spur_enroll_owners_in_workflow` 💲, `spur_send_sms` 💲 | Drafting never sends; new workflows are inactive drafts |
| Email & SMS templates | `spur_list_message_templates`, `spur_get_message_template`, `spur_preview_message_template` ✉️, `spur_preview_message_draft` ✉️, `spur_create_email_template` ✉️, `spur_update_email_template` ✉️, `spur_create_sms_template` ✉️, `spur_update_sms_template` ✉️, `spur_delete_message_template`, `spur_send_test_email` 💲 | See below; the test email only goes to the user's own inbox |
| Inbox | `spur_list_sms_conversations`, `spur_get_sms_conversation` | |
| Postcards | `spur_list_postcard_templates`, `spur_get_postcard_template`, `spur_preview_postcard_template` 🖼, `spur_create_postcard_template` 🖼, `spur_update_postcard_template` 🖼, `spur_delete_postcard_template`, `spur_list_return_addresses`, `spur_preview_postcard_campaign` 🖼, `spur_send_postcards` 💲 | See below |
| QR codes | `spur_list_qr_codes`, `spur_create_qr_code`, `spur_update_qr_code`, `spur_delete_qr_code`, `spur_get_qr_code_activity`, `spur_add_postcard_qr_code` 🖼, `spur_remove_postcard_qr_code` 🖼 | See below |
| Images | `spur_list_images`, `spur_upload_image` 📤, `spur_save_image`, `spur_delete_image` | See below |
| Letters | `spur_list_letter_templates`, `spur_get_letter_template`, `spur_preview_letter_template` 🖼, `spur_create_letter_template` 🖼, `spur_update_letter_template` 🖼, `spur_delete_letter_template`, `spur_preview_letter_campaign` 🖼, `spur_send_letters` 💲 | See below |
| Reporting | `spur_get_billing_summary`, `spur_list_campaigns`, `spur_get_campaign_stats`, `spur_get_direct_mail_analytics`, `spur_get_outreach_report` | |
| Billing | `spur_show_billing_options` 💳, `spur_top_up_wallet` 💳, `spur_change_plan` 💳💲, `spur_check_payment` 💳, `spur_manage_billing` 💳, `spur_set_auto_recharge` 💲 | See below |
| Automations | `spur_list_search_automations`, `spur_create_search_automation`, `spur_run_search_automation`, `spur_get_automation_logs` | Supports weekly, biweekly and monthly schedules, with day of week, week of month and time zone |
| ChatGPT | `search`, `fetch` | Exact names and result shapes required by ChatGPT deep research and company knowledge |

🗺 property explorer widget · 🖼 mail preview widget (postcards and letters) · ✉️ email/SMS preview widget · 📤 image upload widget · 💳 billing widget · 💲 spends money or contacts people

There are also four resources, `spur://merge-variables`, `spur://postcard-design-guide`, `spur://letter-design-guide` and `spur://email-design-guide`, plus prompts including deal hunt, follow up hot leads, outreach sequence, postcard campaign, letter campaign, and weekly review.

### Email and SMS templates

These are the same `communication_templates` rows (type `email` or `sms`) that Spur → Outreach uses, and the templates that workflow `send_email` / `send_sms` steps send.

- **Design**: `spur_create_email_template` with `start_from_blank: true` gives a 600px, table-based, responsive layout with a hidden preheader and a footer with a postal address and opt-out line. `base_template_id` copies an existing email template, or you can pass full HTML. Edit with `replacements` (exact find → replace in the HTML, subject or text) or full HTML. SMS templates take text plus an optional link-free `fallback_body`.
- **Plain text**: the backend generates an email's plain-text part from its HTML. Editing the HTML regenerates it, unless the stored text was written by hand.
- **Preview**: every create and edit shows the widget with sample data. `spur_preview_message_template` takes an `owner_id` to render with real owner data. `spur_preview_message_draft` renders HTML or text without saving it. The checks flag long subjects, Gmail clipping, scripts and external CSS, relative or alt-less images, missing opt-out wording, merge fields that come out empty, multi-segment or Unicode SMS, and links with no fallback.
- **Automations**: `spur_create_workflow` builds a sequence of `send_email`, `send_sms`, `send_direct_mail` and `wait` steps from saved templates, as an inactive draft. `spur_set_workflow_step_template` changes the template on any send step, including branch steps built in the app. `spur_set_workflow_active` requires `confirm` and refuses while any send step has no template.

### Postcard and letter templates

These are the same `direct_mail_templates` rows (type `postcard` or `letter`) that Spur → Direct Mail uses, so the web app and the assistant always see the same templates. The list tools also include Spur's built-in gallery (`/api/letter-templates`, string ids such as `6x4__just_sold` or `letter-02-expired-listing`).

| Format | Options |
| --- | --- |
| Postcards | `6x4`, `6x9`, `6x11` (trim size; artwork includes 0.125" bleed) |
| Letters | US Letter, one page, in one of two types. `top_first_page`: the address prints in the top 3.15" and shows through the #10 envelope window. `insert_blank_page`: Spur inserts an address page in front, billed as one extra page. |

- **Create**: three starting points. `start_from_blank: true` gives an empty, correctly laid-out starter: a postcard canvas at 300 px/in for the size, or a one-page letter for the letter type. `base_template_id` copies an existing template (yours, a Spur default or a gallery design) so you can redesign it, optionally at another size or letter type. Or write the HTML from scratch.
- **Edit**: send `replacements` (an exact find → replace) for text tweaks, or full HTML for a redesign. A replacement that doesn't match exactly once fails without saving anything. Letters can also switch `letter_type`. Defaults and gallery designs are read-only, so copying is how users customize them.
- **Images**: the user's image library is the one behind Spur's image picker (`/api/assets`, Supabase storage with public URLs), so saved images work in postcard, letter and email HTML and every preview inlines them. Assistants can't pass an image attached in chat to a tool, so `spur_upload_image` opens an upload widget. The user picks or drops a file, and the widget resizes large photos to print resolution (3600 px long edge, under 3 MB) and sends them to the app-only `spur_save_uploaded_image`. `spur_save_image` downloads from a public link using the same host checks as preview inlining. Both check the file's real type from its bytes and upload the way the web app does: a signed URL, then `/api/assets/complete`. `spur_delete_image` refuses images that a postcard, letter or email template still uses.
- **QR codes**: the QR tools manage the same parent codes as Spur → QR codes (`/api/direct-mail/qr-codes`). `spur_add_postcard_qr_code` writes the placeholder Spur's editor writes (`<img src="{{qrUrl}}" data-spur-qr-merge="true" data-spur-parent-qr-id="…">`). At send time the backend reads the parent id, mints one tracked code per recipient and fills `{{qrUrl}}`. With `position: "auto"` it fills the back's QR slot (`.qr-box` and the other selectors the editor uses; every gallery design has one). Otherwise it goes in a corner of the message area (bottom-right by default), positioned in percentages of the `.postcard` canvas so it scales with the card. Explicit `x_inches`/`y_inches` spots inside the USPS clear zone are refused. A card holds one QR, so adding replaces the old one. Previews show the parent's image and name the linked code. `spur_preview_postcard_campaign` refuses cards whose placeholder is unlinked (it would print blank) or points at a deleted code (the send would fail). `spur_delete_qr_code` refuses codes that a template still prints. Changing a code's destination also updates the redirect that mailed postcards scan through. `spur_get_qr_code_activity` lists the recipients who scanned.
- **USPS clear zone (postcard backs)**: Spur paints three boxes white on the back when it prints: postage (1.25"×1.25", top-right), the address block (3.5"×2", 0.5" from the right and 1.35" from the top) and the barcode strip (4.75"×0.625", bottom-right). Anything designed there is cut from the card. `src/postcardZones.ts` mirrors those boxes, and `tests/api/outreach/postcard-clear-zone.test.ts` fails if it drifts from the backend's `getPostcardSpec`. The zone geometry for the card's size is in the tool guidance and in every preview result. The widget draws the zones on the back, and `views/clearZone.ts` renders the back at its real size, mapped the way the backend scales it, to find any visible text or image inside a zone. Results are reported to the assistant with what to move and where. While anything is inside a zone, the widget's Send button is blocked. Blank backs start with a message area that already avoids every zone.
- After each create or edit, the preview widget renders the piece with sample owner data. For letters it marks the address band (Top First Page), shows the inserted address page (Insert Blank Page), and warns when content runs past one page.

### Topping up and upgrading

The tools call the backend's existing Stripe endpoints (`/api/billing/checkout/wallet`, `/checkout/subscription`, `/checkout/:sessionId`, `/portal`, `/wallet/auto-recharge`), the same ones Spur → Billing uses.

- **One step for the user**: "add $50" or "upgrade me to Team" returns a Stripe Checkout link and a Pay button. The user pays on Stripe's page; card details never pass through the chat or this server. Making a link moves no money, so it needs no `confirm`.
- **Confirming**: `spur_check_payment` takes the link's `session_id` and reports the new balance and plan. It also runs the backend's missed-webhook fallback, so a paid top-up shows up right away. Checking again never credits twice.
- **Charges to the saved card need approval**: switching an *active* subscription changes it in place, and Stripe prorates the difference. `spur_change_plan` describes the change first and only switches with `confirm: true`. Turning on `spur_set_auto_recharge` works the same way. The widget shows its own confirm step for both.
- **Downgrading to Solo** and managing cards or invoices go through the Stripe billing portal (`spur_manage_billing`).
- Billing errors (HTTP 402 / `BILLING_*`) and low-wallet mail previews point the assistant at these tools. The mail preview widget shows a **Top up wallet** button when the estimate exceeds the balance.

### Safety model for actions that spend money or contact people

1. Every tool marked 💲 requires `confirm: true`. The schema describes it as "only after the user explicitly approved this exact action". It also carries `destructiveHint`/`openWorldHint` annotations, so Claude and ChatGPT ask for approval before running it.
2. `spur_send_postcards` only accepts a `confirmation_token` from `spur_preview_postcard_campaign`, and `spur_send_letters` only one from `spur_preview_letter_campaign`. Tokens are AES-GCM sealed for their mail type (a postcard token can't mail letters, and the reverse) and tied to that exact template, recipient set, return address and size (letters: letter type, color and double-sided). It expires after 30 minutes and can't be forged or edited. The preview shows the artwork, any skipped recipients, the cost estimate and the wallet balance.
3. The widget's Send button shows its own confirm step ("Mail 10 postcards to real people? … about $9.90").
4. Spur's own billing checks still run. If the user is over their limits, the tool error tells the assistant to call `spur_show_billing_options` so the user can top up or upgrade in one click.

## Authentication

The server runs a small **stateless OAuth 2.1 bridge**:

- Dynamic client registration (RFC 7591), PKCE S256 only, and discovery at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`.
- `/oauth/authorize` shows a Spur sign-in page (email and password, plus the MFA code step when the account has MFA). It calls Spur's `/api/auth/login` and `/api/auth/mfa/verify`.
- When `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set, the page also offers **Continue with Google**. It runs the same Supabase OAuth flow as the Spur web app: PKCE on the server, with the verifier in a short-lived sealed cookie bound to the browser. The Supabase user then goes to Spur's `/api/auth/oauth/callback`. Add `$MCP_PUBLIC_URL/oauth/google/callback` to **Supabase → Authentication → URL Configuration → Redirect URLs**. If it is missing, Supabase sends users to the web app's Site URL instead.
- Spur's access and refresh JWTs are sealed inside our codes and tokens, so there is no database. Our access token expires when the Spur access token inside it does. Refreshing goes through `/oauth/token`, which rotates Spur's refresh token in one place.
- Spur still controls the session. Revoking the user's sessions in Spur → Security revokes the connector too.

On multi-instance or serverless deployments, every instance needs the same `MCP_TOKEN_SECRET`. Each instance tracks single-use authorization codes in memory, so a replayed code could succeed on a different instance within its 5-minute lifetime. PKCE still prevents a stolen code from being used without the client's verifier.

## Run locally

```bash
cd mcp
npm install
cp .env.example .env   # point SPUR_API_URL at your backend
npm run build
set -a; source .env; set +a
npm start              # → http://localhost:8787/mcp
```

Explore it with `npx @modelcontextprotocol/inspector`, connecting to `http://localhost:8787/mcp` with OAuth.

**stdio** (Claude Desktop / Claude Code, single user, no OAuth):

```json
{
  "mcpServers": {
    "spur": {
      "command": "node",
      "args": ["/path/to/spur/mcp/dist/index.js"],
      "env": { "TRANSPORT": "stdio", "SPUR_API_URL": "http://localhost:3001", "SPUR_ACCESS_TOKEN": "…", "SPUR_REFRESH_TOKEN": "…" }
    }
  }
}
```

## Deploy on Vercel

`api/index.js` exports the HTTP app as a Vercel function and `vercel.json` routes every path to it (`npm run build` runs first). Create a Vercel project with **Root Directory** `mcp`, then set:

| Variable | Value |
| --- | --- |
| `SPUR_API_URL` | Production Spur backend, no `/api` suffix |
| `MCP_PUBLIC_URL` | The custom domain, e.g. `https://mcp.spur.example` (OAuth issuer; keep it stable). Defaults to the project's production domain |
| `MCP_TOKEN_SECRET` | 32+ random characters; rotating it signs every connector out |
| `SPUR_APP_URL` | Spur web app URL |
| `MAP_TILE_CONTACT` | Contact email for the tile provider |
| `WIDGET_IMAGE_DOMAINS` | Optional: postcard artwork origins |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Optional: enables Continue with Google (same values as the web app's `VITE_SUPABASE_*`) |

`HOST` and `PORT` are not needed on Vercel. The deployment's `*.vercel.app` hostnames are accepted automatically; other hostnames go in `MCP_ALLOWED_HOSTS`. Tiles are sent with `s-maxage`, so Vercel's CDN serves repeat requests; the in-memory tile cache and per-IP limit apply per function instance. Functions stop after 60 seconds (`maxDuration` in `vercel.json`).

## Connect to Claude and ChatGPT

Both need a public HTTPS URL. Deploy the server, then set `MCP_PUBLIC_URL` (for example `https://mcp.spur.example`), `HOST=0.0.0.0` and a real `MCP_TOKEN_SECRET`.

- **Claude**: Settings → Connectors → Add custom connector → `https://mcp.spur.example/mcp`. Claude registers itself, opens the Spur sign-in page, and the widgets render inline.
- **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode → Create → MCP server URL `https://mcp.spur.example/mcp`, authentication OAuth.

For the map, the widget loads tiles through this server's caching proxy at `/tiles/{z}/{x}/{y}.png`, never from the tile server directly. That is what the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/) asks of production apps:

- Every upstream request sends `User-Agent: spur-mcp-server/<version> (+MCP_PUBLIC_URL; MAP_TILE_CONTACT)` and a `Referer`. Set `MAP_TILE_CONTACT` to an email address the OSM operations team can reach.
- Tiles are cached in memory (`MAP_TILE_CACHE_MB`, LRU), honour the upstream `Cache-Control`/`Expires`, and are revalidated with `If-None-Match`/`If-Modified-Since`. Concurrent requests for one tile share one fetch. A stale tile is served if the tile server is down.
- Upstream fetches are capped (`MAP_TILE_UPSTREAM_CONCURRENCY`), and each client IP is limited to `MAP_TILE_CLIENT_LIMIT` tiles per 5 minutes. Only valid z/x/y up to zoom 19 are accepted, so the proxy can't be used as an open mirror.
- The map shows "© OpenStreetMap contributors" linked to the copyright page.

OpenStreetMap's tile servers are donated, have no SLA, and may throttle or block heavy users without notice. The proxy logs once if the tile server answers 403 or 429. If that happens, or as traffic grows, set `MAP_TILE_URL` to a provider that serves OpenStreetMap tiles commercially (for example MapTiler, Stadia or Thunderforest) and update `MAP_TILE_ATTRIBUTION`. API keys in `MAP_TILE_URL` never reach the browser. On stdio there is no HTTP server, so the widget loads `MAP_TILE_URL` directly. If postcard artwork is hosted somewhere other than the Spur API origin (for example Supabase storage), add that origin to `WIDGET_IMAGE_DOMAINS` so the host's sandbox CSP lets the preview load it.

## List in the MCP Registry

[`server.json`](server.json) describes the production connector (`https://mcp.usespur.com/mcp`) for the [MCP Registry](https://registry.modelcontextprotocol.io) as `com.usespur/spur`. It is a remote-only listing: no package is published. The registry proves we own `usespur.com` through a DNS TXT record on the apex domain (`@` in Namecheap → Advanced DNS):

```
v=MCPv1; k=ecdsap384; p=<base64 public key>
```

The matching private key is kept outside the repo (never commit it). If you rotate it, delete the old TXT record, because a stale record breaks verification.

To publish a new version, bump `version` in `server.json` and run:

```bash
brew install mcp-publisher
mcp-publisher validate
PRIVATE_KEY="$(openssl ec -in ~/.config/mcp-registry/usespur-key.pem -noout -text | grep -A4 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --algorithm ecdsap384 --domain usespur.com --private-key "$PRIVATE_KEY"
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.usespur/spur"
```

`description` is capped at 100 characters and is what registry search matches, so keep the key terms (real estate, skip tracing, direct mail, outreach, marketing automations) in it.

## Develop and test

```bash
npm run build   # tsc (server) + tsc -p views (widgets) + bundle widgets into dist/views/*.html
npm test        # build + scripts/smoke.ts
```

`scripts/smoke.ts` runs against a **mock Spur API**, so no real providers are contacted. It covers:

- Discovery, client registration, the sign-in page, wrong passwords, the MFA flow, PKCE, single-use codes and refresh.
- Tool listing, widget resources and their CSP, search → save, copying and editing postcard templates, and failures for invalid replacements.
- QR codes: create and edit, placement in a slot, in the message area and at refused spots, replacing instead of duplicating, removal, the send guards, delete protection and scan activity.
- Every mail format end to end: postcards in all three sizes and letters in both types, each going from a blank start to a design, a preview with real recipient data and the plan price, then approval and send (checking the order payload). Also covers redesigning gallery templates, including resizing and switching letter type, and keeping gallery and default templates read-only.
- The preview → send path: missing `confirm`, tampered tokens and tokens for the other mail type are rejected, and only mailable owners are sent.
- Email and SMS templates: blank layout → edit → inbox preview with sample and real owner data, plain text regenerated (or hand-written text kept), draft checks, a test send to self, SMS segment and Unicode detection. Then a workflow built from those templates, a step's template swapped (with every step sent back), and activation that requires approval.
- ChatGPT `search`, and stdio mode refreshing a stale token.

Widget source lives in `views/`, as plain TypeScript and CSS with no framework. `scripts/build-views.mjs` inlines everything into a single HTML file per widget, because hosts render widgets in sandboxed iframes.

## Limits and next steps

- `spur_find_owners` and `search` filter client-side over `GET /api/owners`/`/api/properties`, because those endpoints don't take a search parameter. A server-side `q` parameter would help large accounts.
- Cost estimates use the plan's included allowance, then the plan price: the size variant for postcards, plus one extra page for Insert Blank Page letters. Letters whose content spills onto more pages are flagged in the preview but not priced for the extra pages. The backend's billing check is still authoritative.
- The widget bundles are about 600–760 KB each, mostly the MCP Apps SDK and its schema library. They're cached per resource URI; bump the `-v1` suffix in `src/widgets.ts` when a change must reach clients that cached the old version.
