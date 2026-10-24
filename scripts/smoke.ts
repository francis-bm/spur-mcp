/**
 * End-to-end self-check against a mock Spur API (no real providers are contacted).
 * Starts the built server over HTTP, runs the full OAuth flow like Claude/ChatGPT would,
 * then exercises tools, widgets and the postcard send guardrails. Exits non-zero on failure.
 *
 * Run: npm test   (builds first)
 */
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import express from "express";

// ---------------------------------------------------------------- mock Spur API

const fakeJwt = (sub: string, ttlSeconds = 900) => {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "HS256" })}.${b64({ userId: sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds })}.sig`;
};

const calls: Array<{ method: string; path: string; body: any; auth?: string }> = [];
let refreshCount = 0;
// Mutable billing account behind /api/billing/*: Stripe checkout sessions are simulated in memory
const billingAccount = {
  planId: "solo",
  billingInterval: null as string | null,
  subscriptionStatus: null as string | null,
  stripeSubscriptionId: null as string | null,
  stripeCustomerId: null as string | null,
  defaultPaymentMethodId: null as string | null,
  autoRechargeEnabled: false,
  autoRechargeAmountCents: null as number | null,
  autoRechargeThresholdCents: null as number | null
};
let walletUsd = 50;
const checkoutSessions = new Map<string, { amountCents?: number; planId?: string; interval?: string; paid: boolean; credited: boolean }>();
const billingCatalog = [
  { id: "solo", name: "Solo", tier: 0, pricing: { monthlyCents: 0, annualCents: 0, annualMonthlyEquivalentCents: 0 }, highlights: ["1 QR code"] },
  { id: "agent", name: "Agent", tier: 1, pricing: { monthlyCents: 2500, annualCents: 22800, annualMonthlyEquivalentCents: 1900 }, highlights: ["3 QR codes"] },
  { id: "team", name: "Team", tier: 2, pricing: { monthlyCents: 9900, annualCents: 94800, annualMonthlyEquivalentCents: 7900 }, highlights: ["10 QR codes"] }
];
const tileRequests: Array<{ path: string; userAgent?: string; referer?: string }> = [];

const templates: any[] = [
  {
    id: "tpl-default",
    name: "Just Sold",
    type: "postcard",
    size: "6x4",
    is_default: true,
    front_html: "<html><body><h1>Just Sold!</h1></body></html>",
    back_html: "<html><body><p>Hi {{owner_first_name}}, call {{your_phone}}</p></body></html>"
  }
];

/** Spur's built-in gallery (/api/letter-templates): string ids, never editable or mailable directly */
const gallery: any[] = [
  {
    id: "6x4__open_house",
    name: "Open House",
    type: "postcard",
    size: "6x4",
    category: "Marketing",
    front_html: "<html><body><h1>Open House</h1></body></html>",
    back_html: "<html><body><p>Stop by, {{owner_first_name}}</p></body></html>"
  },
  {
    id: "letter-02-expired-listing",
    name: "Expired Listing",
    type: "letter",
    category: "Follow Up",
    html_content: '<html><body><div class="letter"><div class="letterhead">Acme Realty</div><p>Dear {{owner_first_name}}, your listing expired.</p></div></body></html>',
    letter_template_tag: "Insert Blank Page",
    metadata: { address_placement: "insert_blank_page" }
  }
];

/** communication_templates rows (email/SMS) and outreach workflows, as the backend returns them */
const messageTemplates: any[] = [
  { id: "ct-sms-1", template_name: "First touch", template_type: "sms", body: "Hi {{owner_first_name}}, it's {{your_name}}. Reply STOP to opt out.", is_default: false, is_active: true }
];
const workflows: any[] = [];
/** user_assets rows and the storage objects behind them */
const assets: any[] = [];
const storedObjects = new Map<string, { type: string; body: Buffer }>();
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** direct_mail_qr_codes rows; qr-seed is the parent the default template's QR placeholder points at */
const qrCodes: any[] = [
  { id: "qr-seed", name: "Seed offer", destination_url: "https://acme.example/seed", public_token: "tokseed", foreground_color: "#111827", background_color: "#FFFFFF" }
];
/** Stand-in for templateService.htmlToText */
const htmlToTextMock = (html: string) =>
  html.replace(/<(head|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<div[^>]*display:none[^>]*>[\s\S]*?<\/div>/gi, " ").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").trim();

const owners = [
  { id: "own-1", full_name: "Pat Lee", mailing_address: "9 Oak St, Austin, TX 78704", phone_numbers: ["+15125550101"], email: null, enrichment_status: "enriched", property_count: 1 },
  { id: "own-2", full_name: "Sam Noaddr", mailing_address: "", phone_numbers: [], email: null, enrichment_status: "pending", property_count: 1 }
];

const listing = {
  zpid: 111,
  address: { streetAddress: "1428 Elm St", city: "Austin", state: "TX", zipcode: "78704" },
  location: { latitude: 30.25, longitude: -97.76 },
  price: 2350,
  propertyType: "singleFamily",
  bedrooms: 3,
  bathrooms: 2,
  livingArea: 1640,
  listingStatus: "forRent",
  photoUrl: "https://photos.zillowstatic.com/x.jpg",
  detailUrl: "https://www.zillow.com/homedetails/111_zpid/",
  allPhotos: ["a", "b"]
};

function startMockSpur(): Promise<string> {
  const api = express();
  api.use(express.json({ limit: "5mb" }));
  api.use((req, _res, next) => {
    calls.push({ method: req.method, path: req.path, body: req.body, auth: req.headers.authorization });
    next();
  });
  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!req.headers.authorization?.startsWith("Bearer ey")) return res.status(401).json({ success: false, error: "Authentication required" });
    next();
  };

  api.post("/api/auth/login", (req, res) => {
    if (req.body.email === "mfa@example.com") return res.json({ success: true, requiresMfa: true, mfaMethod: "totp", challengeToken: "challenge-1" });
    if (req.body.password !== "correct-horse") return res.status(401).json({ success: false, error: "Invalid email or password" });
    res.json({ success: true, accessToken: fakeJwt("user-1"), refreshToken: "refresh-1", expiresIn: "15m" });
  });
  api.post("/api/auth/mfa/verify", (req, res) => {
    if (req.body.challengeToken !== "challenge-1" || req.body.code !== "123456") return res.status(401).json({ success: false, error: "Invalid verification code" });
    res.json({ success: true, accessToken: fakeJwt("user-2"), refreshToken: "refresh-mfa" });
  });
  // Stands in for Supabase Auth's PKCE token exchange, then Spur linking the Google identity
  api.post("/auth/v1/token", (req, res) => {
    if (req.query.grant_type !== "pkce" || req.headers.apikey !== "anon-key" || req.body.auth_code !== "google-code") {
      return res.status(400).json({ error: "invalid_grant" });
    }
    res.json({ access_token: "supabase-access", user: { id: "sb-user-1", email: "g@example.com", app_metadata: { provider: "google" }, user_metadata: { full_name: "Gee User" } } });
  });
  api.post("/api/auth/oauth/callback", (req, res) => {
    if (req.body.providerUserId !== "sb-user-1" || req.body.email !== "g@example.com") return res.status(400).json({ success: false, error: "OAuth authentication failed" });
    res.json({ success: true, accessToken: fakeJwt("user-3"), refreshToken: "refresh-google" });
  });
  api.post("/api/auth/refresh", (req, res) => {
    refreshCount++;
    if (!String(req.body.refreshToken).startsWith("refresh-")) return res.status(401).json({ success: false, error: "Invalid refresh token" });
    res.json({ success: true, accessToken: fakeJwt("user-1"), refreshToken: `refresh-${refreshCount + 1}` });
  });

  // Stands in for tile.openstreetmap.org behind the MCP tile proxy
  api.get("/osm/:z/:x/:file", (req, res) => {
    tileRequests.push({ path: req.path, userAgent: req.headers["user-agent"], referer: req.headers.referer });
    if (req.params.z === "4") return res.status(404).end();
    setTimeout(() => res.set({ "Content-Type": "image/png", "Cache-Control": "max-age=86400", ETag: '"t1"' }).send(Buffer.from("png-bytes")), 50);
  });

  // Public in the backend too: printers and previews load QR images without a session
  api.get("/api/direct-mail/qr/:token/image.png", (_req, res) => res.type("image/png").send(Buffer.from("fake-qr")));

  // Stands in for Supabase Storage (signed uploads, public objects) and an image on the user's website
  api.put("/storage/v1/object/upload/sign/*path", express.raw({ type: () => true, limit: "10mb" }), (req, res) => {
    if (req.query.token !== "signed") return res.status(403).end();
    storedObjects.set((req.params as any).path.join("/"), { type: String(req.headers["content-type"]), body: req.body as Buffer });
    res.json({ Key: (req.params as any).path.join("/") });
  });
  api.get("/storage/v1/object/public/*path", (req, res) => {
    const object = storedObjects.get((req.params as any).path.join("/"));
    return object ? res.type(object.type).send(object.body) : res.status(404).end();
  });
  api.get("/media/logo.png", (_req, res) => res.type("image/png").send(TINY_PNG));
  api.get("/media/page.html", (_req, res) => res.type("text/html").send("<html><body>Not an image</body></html>"));

  api.use("/api", requireAuth);
  api.post("/api/zillow/search", (req, res) => {
    if (!req.body.events) return res.json({ status: true, data: [listing], count: 1, meta: { aiUsed: true } });
    res.json({
      status: true,
      count: 1,
      data: [{ ...listing, listingStatus: "forSale", price: 270000, events: ["price_drop"], eventDetails: { price_drop: { previousPrice: 300000, price: 270000, changePct: -10 } } }],
      meta: {
        aiUsed: false,
        filterStats: { input: 4, absentee: 3, output: 1 },
        eventStats: { events: ["price_drop", "back_on_market"], skippedEvents: [], calls: 2, pulled: 4, matched: 1, perEvent: { price_drop: 1, back_on_market: 0 }, baselineRows: 0, truncated: [] }
      }
    });
  });
  api.post("/api/zillow/parse-query", (_req, res) =>
    res.json({
      success: true,
      source: "ai",
      data: { location: "Houston, TX", status: "forSale", homeType: "multiFamily", maxAmount: 400000, events: ["price_drop", "back_on_market"], eventWithinDays: 7, has3DTour: true, semanticIntent: "older duplexes, excluding condos", bogusKey: 1 }
    })
  );
  api.post("/api/automation/configs", (req, res) =>
    res.status(201).json({ success: true, data: { id: "auto-1", ...req.body, next_run_at: "2026-10-24T12:00:00Z" } })
  );
  api.post("/api/zillow/save-property", (req, res) =>
    res.json({ success: true, data: { action: "created", property: { id: `prop-${req.body.zpid}`, address: req.body.address.streetAddress } } })
  );
  api.get("/api/properties", (_req, res) =>
    res.json({ success: true, data: [{ id: "prop-1", address: "1428 Elm St", city: "Austin", state: "TX", zip_code: "78704", latitude: "30.25", longitude: "-97.76", amount: "2350.00", enrichment_status: "enriched" }] })
  );
  api.get("/api/owners", (_req, res) => res.json({ success: true, data: owners }));
  api.get("/api/direct-mail/templates", (req, res) => res.json({ success: true, data: templates.filter(t => !req.query.type || t.type === req.query.type) }));
  api.get("/api/direct-mail/templates/:id", (req, res) => {
    const t = templates.find(x => x.id === req.params.id);
    return t ? res.json({ success: true, data: t }) : res.status(404).json({ success: false, error: "Template not found" });
  });
  api.post("/api/direct-mail/templates", (req, res) => {
    const t = { id: `tpl-${templates.length + 1}`, is_default: false, ...req.body };
    templates.push(t);
    res.status(201).json({ success: true, data: t });
  });
  api.put("/api/direct-mail/templates/:id", (req, res) => {
    const t = templates.find(x => x.id === req.params.id);
    if (!t || t.is_default) return res.status(403).json({ success: false, error: "Not authorized to update this template" });
    Object.assign(t, req.body);
    res.json({ success: true, data: t });
  });
  api.post("/api/direct-mail/preview", (req, res) => {
    const fill = (html: string) => html.replace(/\{\{(\w+)\}\}/g, (_m, k) => req.body.merge_variables?.[k] ?? "");
    if (req.body.type === "letter") {
      // Echo the placement so tests can see previews render in the letter type's layout
      return res.json({ success: true, data: { type: "letter", html: `${fill(req.body.html_content)}<!--placement:${req.body.address_placement}-->` } });
    }
    res.json({ success: true, data: { type: "postcard", front_html: fill(req.body.front_html), back_html: fill(req.body.back_html) } });
  });
  api.get("/api/letter-templates", (req, res) =>
    res.json({ success: true, data: gallery.filter(g => !req.query.type || g.type === req.query.type) })
  );
  api.get("/api/letter-templates/:id", (req, res) => {
    const g = gallery.find(x => x.id === req.params.id);
    return g ? res.json({ success: true, data: g }) : res.status(404).json({ success: false, error: "Template not found" });
  });
  api.get("/api/direct-mail/return-addresses", (_req, res) =>
    res.json({ success: true, data: [{ id: "ra-1", name: "HQ", address_line1: "1 Main St", city: "Austin", state: "TX", postal_code: "78701", is_default: true }] })
  );
  api.post("/api/communication/template-data/build", (req, res) =>
    res.json({ success: true, data: { owner_first_name: req.body.owner_id === "own-1" ? "Pat" : undefined, your_phone: "512-555-0199" } })
  );
  // Email/SMS templates and their render-preview, mirroring templateService (HTML-only emails get generated text)
  api.get("/api/communication/templates", (req, res) =>
    res.json({ success: true, data: messageTemplates.filter(t => !t.deleted && (!req.query.type || t.template_type === req.query.type)) })
  );
  api.post("/api/communication/templates/preview-content", (req, res) => {
    const data: Record<string, string> = req.body.owner_id === "own-1" ? { owner_first_name: "Pat", your_name: "Alex" } : { owner_first_name: "Jordan", your_name: "Alex", property_address: "1428 Elm Street" };
    const fill = (t: string | null) => (t == null ? null : t.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => data[k] ?? m));
    const vars = (t: string | null) => [...(t || "").matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]);
    const source = req.body.template_type === "email" && req.body.html_content && !req.body.body ? htmlToTextMock(req.body.html_content) : req.body.body || "";
    const rendered = { subject: fill(req.body.subject || null), body: fill(source) as string, html_content: fill(req.body.html_content || null), fallback_body: fill(req.body.fallback_body || null) };
    res.json({
      success: true,
      data: {
        ...rendered,
        source_body: source,
        variables: [...new Set([req.body.subject, source, req.body.html_content, req.body.fallback_body].flatMap(vars))],
        unresolved_variables: [...new Set(Object.values(rendered).flatMap(vars))]
      }
    });
  });
  api.get("/api/communication/templates/:id", (req, res) => {
    const t = messageTemplates.find(x => x.id === req.params.id && !x.deleted);
    return t ? res.json({ success: true, data: t }) : res.status(404).json({ success: false, error: "Template not found" });
  });
  api.post("/api/communication/templates", (req, res) => {
    if (req.body.template_type === "email" && !req.body.subject) return res.status(500).json({ success: false, error: "Validation failed: Subject line is required for email templates" });
    const t = { id: `ct-${messageTemplates.length + 1}`, ...req.body, body: req.body.body || htmlToTextMock(req.body.html_content || "") };
    messageTemplates.push(t);
    res.json({ success: true, data: t });
  });
  api.put("/api/communication/templates/:id", (req, res) => {
    const t = messageTemplates.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ success: false, error: "Template not found" });
    Object.assign(t, req.body, { body: req.body.body || htmlToTextMock(req.body.html_content || "") });
    res.json({ success: true, data: t });
  });
  api.delete("/api/communication/templates/:id", (req, res) => {
    const t = messageTemplates.find(x => x.id === req.params.id);
    if (t) t.deleted = true;
    res.json({ success: true });
  });
  api.get("/api/email-senders", (_req, res) => res.json({ success: true, data: [{ id: "es-1", display_name: "Alex at Acme", email: "alex@acme.example", is_default: true, is_active: true }] }));
  api.post("/api/email-senders/send-test", (req, res) => res.json({ success: true, data: { recipient: "me@acme.example", subject: req.body.subject } }));

  api.get("/api/outreach/workflows", (_req, res) => res.json({ success: true, data: workflows }));
  api.get("/api/outreach/workflows/:id", (req, res) => {
    const w = workflows.find(x => x.id === req.params.id);
    return w ? res.json({ success: true, data: w }) : res.status(404).json({ success: false, error: "Workflow not found" });
  });
  api.post("/api/outreach/workflows", (req, res) => {
    const { steps, ...rest } = req.body;
    const id = `wf-${workflows.length + 1}`;
    const w = { id, ...rest, steps: steps.map((st: any, i: number) => ({ id: `${id}-s${i + 1}`, step_type: st.type, step_order: st.step_order, config: st.config, parent_step_id: null })) };
    workflows.push(w);
    res.status(201).json({ success: true, data: w });
  });
  api.put("/api/outreach/workflows/:id/toggle", (req, res) => {
    const w = workflows.find(x => x.id === req.params.id);
    Object.assign(w, { is_active: req.body.is_active, status: req.body.is_active ? "active" : "paused" });
    res.json({ success: true, data: w });
  });
  api.put("/api/outreach/workflows/:id", (req, res) => {
    const w = workflows.find(x => x.id === req.params.id);
    const { steps, ...rest } = req.body;
    Object.assign(w, rest, steps ? { steps } : {});
    res.json({ success: true, data: w });
  });

  api.get("/assets/photo.png", (_req, res) => res.type("image/png").send(Buffer.from("fake-png")));
  api.get("/qr/sample/image.png", (_req, res) => res.type("image/png").send(Buffer.from("fake-qr")));
  api.get("/api/billing/summary", (_req, res) =>
    res.json({
      success: true,
      data: {
        account: billingAccount,
        wallet: { balanceUsd: walletUsd, topUpPresetAmountsCents: [2500, 5000, 10000], minTopUpAmountCents: 500 },
        catalog: billingCatalog,
        stripeEnabled: true,
        metrics: {
          postcard: { label: "Postcards", unitPriceMicros: 990000, remaining: 0, includedMonthly: 0, used: 10 },
          letter: { label: "Letters", unitPriceMicros: 1390000, remaining: 0, includedMonthly: 0, used: 0 }
        },
        // Same shape as backend/src/billing/catalog.js: size variants for postcards, per-page extra for letters
        plan: {
          features: {
            postcard: { unitPriceMicros: 990000, variantPrices: { "6x4": { unitPriceMicros: 990000 }, "6x9": { unitPriceMicros: 1190000 }, "6x11": { unitPriceMicros: 1390000 } } },
            letter: { unitPriceMicros: 1390000, additionalUnitPriceMicros: 390000 }
          }
        }
      }
    })
  );
  api.post("/api/billing/checkout/wallet", (req, res) => {
    if (!(req.body.amount_cents >= 500)) return res.status(400).json({ success: false, error: "Wallet top-up amount must be at least $5." });
    const id = `cs_test_${checkoutSessions.size + 1}`;
    checkoutSessions.set(id, { amountCents: req.body.amount_cents, paid: false, credited: false });
    res.json({ success: true, data: { mode: "checkout", checkoutUrl: `https://checkout.stripe.com/c/pay/${id}`, sessionId: id } });
  });
  api.post("/api/billing/checkout/subscription", (req, res) => {
    const { plan_id, billing_interval } = req.body;
    if (billingAccount.stripeSubscriptionId && billingAccount.subscriptionStatus === "active") {
      Object.assign(billingAccount, { planId: plan_id, billingInterval: billing_interval });
      return res.json({ success: true, data: { mode: "subscription_updated", subscriptionId: billingAccount.stripeSubscriptionId } });
    }
    const id = `cs_test_${checkoutSessions.size + 1}`;
    checkoutSessions.set(id, { planId: plan_id, interval: billing_interval, paid: false, credited: false });
    res.json({ success: true, data: { mode: "checkout", checkoutUrl: `https://checkout.stripe.com/c/pay/${id}`, sessionId: id } });
  });
  api.get("/api/billing/checkout/:id", (req, res) => {
    const session = checkoutSessions.get(req.params.id);
    if (!session) return res.status(400).json({ success: false, error: "No such checkout session" });
    // Like the backend's missed-webhook fallback: a paid top-up is credited exactly once
    if (session.paid && session.amountCents && !session.credited) {
      walletUsd += session.amountCents / 100;
      session.credited = true;
      Object.assign(billingAccount, { stripeCustomerId: "cus_1", defaultPaymentMethodId: "pm_1" });
    }
    if (session.paid && session.planId) {
      Object.assign(billingAccount, { planId: session.planId, billingInterval: session.interval, subscriptionStatus: "active", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    }
    res.json({ success: true, data: { id: req.params.id, status: session.paid ? "complete" : "open", paymentStatus: session.paid ? "paid" : "unpaid" } });
  });
  api.post("/api/billing/portal", (_req, res) => {
    if (!billingAccount.stripeCustomerId) return res.status(400).json({ success: false, error: "No Stripe customer found for this account yet." });
    res.json({ success: true, data: { url: "https://billing.stripe.com/p/session/test_1" } });
  });
  api.post("/api/billing/wallet/auto-recharge", (req, res) => {
    Object.assign(billingAccount, {
      autoRechargeEnabled: Boolean(req.body.enabled),
      autoRechargeAmountCents: req.body.amount_cents ?? null,
      autoRechargeThresholdCents: req.body.threshold_cents ?? null
    });
    res.json({ success: true, data: {} });
  });
  api.post("/api/direct-mail/orders/bulk", (req, res) =>
    res.status(202).json({ success: true, queued: true, data: { batch_id: "batch-1", recipient_count: req.body.owner_ids.length, status: "queued" } })
  );

  // Parent QR codes (direct_mail_qr_codes) and the per-recipient redirect system behind mailed postcards
  const qrImage = (req: express.Request, token: string) => `${req.protocol}://${req.get("host")}/api/direct-mail/qr/${token}/image.png`;
  // Image library (assetController): signed upload URL → PUT to storage → complete
  api.get("/api/assets", (_req, res) => res.json({ success: true, data: [...assets].reverse() }));
  api.post("/api/assets/upload-url", (req, res) => {
    const storagePath = `user-1/${1700000000000 + assets.length}-${req.body.filename}`;
    res.status(201).json({ success: true, data: { storage_path: storagePath, signed_url: `${req.protocol}://${req.get("host")}/storage/v1/object/upload/sign/user-assets/${storagePath}?token=signed`, token: "signed" } });
  });
  api.post("/api/assets/complete", (req, res) => {
    const object = storedObjects.get(`user-assets/${req.body.storage_path}`);
    if (!object) return res.status(404).json({ success: false, error: "Uploaded file not found" });
    const asset = {
      id: `asset-${assets.length + 1}`,
      filename: String(req.body.storage_path).split("/").pop()!.replace(/^\d+-/, ""),
      public_url: `${req.protocol}://${req.get("host")}/storage/v1/object/public/user-assets/${req.body.storage_path}`,
      mime_type: object.type,
      size_bytes: object.body.length,
      created_at: "2026-10-23T12:00:00Z"
    };
    assets.push(asset);
    res.status(201).json({ success: true, data: asset });
  });
  api.delete("/api/assets/:id", (req, res) => {
    const index = assets.findIndex(a => a.id === req.params.id);
    if (index >= 0) assets.splice(index, 1);
    res.json({ success: true });
  });
  api.get("/api/direct-mail/qr-codes",(_req, res) => res.json({ success: true, data: qrCodes }));
  api.post("/api/direct-mail/qr-codes", (req, res) => {
    const token = `tok${qrCodes.length + 1}`;
    const qr = { id: `qr-${qrCodes.length + 1}`, foreground_color: "#111827", background_color: "#FFFFFF", ...req.body, public_token: token, image_url: qrImage(req, token) };
    qr.destination_url = /^https?:\/\//.test(qr.destination_url) ? qr.destination_url : `https://${qr.destination_url}`;
    qrCodes.push(qr);
    res.status(201).json({ success: true, data: qr });
  });
  api.put("/api/direct-mail/qr-codes/:id", (req, res) => {
    const qr = qrCodes.find(q => q.id === req.params.id);
    if (!qr) return res.status(404).json({ success: false, error: "QR code not found" });
    Object.assign(qr, req.body);
    res.json({ success: true, data: qr });
  });
  api.delete("/api/direct-mail/qr-codes/:id", (req, res) => {
    const index = qrCodes.findIndex(q => q.id === req.params.id);
    if (index < 0) return res.status(404).json({ success: false, error: "QR code not found" });
    qrCodes.splice(index, 1);
    res.json({ success: true, message: "QR code deleted" });
  });
  api.get("/api/direct-mail/qr-codes/:id/scans", (req, res) =>
    res.json({ success: true, data: { qr_code: qrCodes.find(q => q.id === req.params.id), scans: [{ scanned_at: "2026-10-20T15:00:00Z", device_type: "mobile", city: "Austin", region: "TX" }] } })
  );
  api.get("/api/qr/redirects", (req, res) =>
    res.json({ success: true, data: req.query.campaignId === "direct_mail_qr:qr-seed" ? [{ id: "redirect-seed", campaign_id: "direct_mail_qr:qr-seed" }] : [] })
  );
  api.get("/api/qr/redirects/:id/manager", (_req, res) =>
    res.json({
      success: true,
      data: {
        redirect: { id: "redirect-seed", total_scan_count: 3, unique_recipient_count: 1 },
        recipients: [
          { owner_id: "own-1", owner_full_name: "Pat Lee", property_address: "9 Oak St", scan_count: 3, last_scanned_at: "2026-10-21T18:30:00Z" },
          { owner_id: "own-9", owner_full_name: "Quiet Owner", property_address: "1 Elm St", scan_count: 0 }
        ]
      }
    })
  );

  return new Promise(resolve => {
    const server = api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

// ---------------------------------------------------------------- helpers

async function waitFor(url: string) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server did not start: ${url}`);
}

const text = (result: any) => (result.content || []).map((c: any) => c.text || "").join("\n");

// ---------------------------------------------------------------- run

let child: ChildProcess | undefined;

async function main() {
  const spurUrl = await startMockSpur();
  // Remote artwork + an unmerged QR placeholder; previews must hand the widget both inlined
  templates[0].front_html = `<html><body><h1>Just Sold!</h1><img src="${spurUrl}/assets/photo.png?w=1&amp;h=1"><img src="{{qrUrl}}" data-spur-qr-merge="true" data-spur-qr-preview-src="${spurUrl}/qr/sample/image.png" data-spur-parent-qr-id="qr-seed"></body></html>`;
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const base = `http://localhost:${port}`;
  child = spawn("node", ["dist/index.js"], {
    env: { ...process.env, PORT: String(port), SPUR_API_URL: spurUrl, MCP_PUBLIC_URL: base, MCP_TOKEN_SECRET: randomBytes(32).toString("hex"), SUPABASE_URL: spurUrl, SUPABASE_ANON_KEY: "anon-key", MAP_TILE_URL: `${spurUrl}/osm/{z}/{x}/{y}.png`, MAP_TILE_CONTACT: "ops@example.com" },
    stdio: ["ignore", "inherit", "inherit"]
  });
  await waitFor(`${base}/healthz`);

  // -- Glama ownership claim is public
  const glama = await fetch(`${base}/.well-known/glama.json`);
  assert.equal(glama.status, 200, "glama.json must be served without auth");
  assert.match((await glama.json()).claim, /^glama_claim_/);

  // -- OAuth discovery + 401 challenge
  const unauth = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401, "unauthenticated /mcp must be 401");
  assert.match(unauth.headers.get("www-authenticate") || "", /resource_metadata=/);

  // -- Unauthenticated discovery: directory indexers may handshake and list tools, but not call them
  const rpc = (message: object, headers: Record<string, string> = {}) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", ...headers },
      body: JSON.stringify(message)
    });
  const rpcResult = async (res: Response) => {
    const raw = await res.text();
    const json = res.headers.get("content-type")?.includes("text/event-stream") ? (/^data: (.*)$/m.exec(raw)?.[1] as string) : raw;
    return JSON.parse(json);
  };
  const anonInit = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "indexer", version: "1" } } });
  assert.equal(anonInit.status, 200, "unauthenticated initialize must succeed");
  assert.equal((await rpcResult(anonInit)).result?.serverInfo?.name, "spur-mcp-server");
  const anonList = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(anonList.status, 200, "unauthenticated tools/list must succeed");
  const anonTools = (await rpcResult(anonList)).result?.tools ?? [];
  assert.ok(anonTools.length > 0 && anonTools.every((t: any) => t.description && t.annotations), "listed tools carry descriptions and annotations");
  const anonCall = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "spur_get_billing_summary", arguments: {} } });
  assert.equal(anonCall.status, 401, "unauthenticated tools/call must be 401");
  assert.match(anonCall.headers.get("www-authenticate") || "", /resource_metadata=/);
  const anonMixed = await rpc([{ jsonrpc: "2.0", id: 4, method: "tools/list" }, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "spur_get_billing_summary", arguments: {} } }]);
  assert.equal(anonMixed.status, 401, "a batch with any non-discovery call needs auth");
  const badToken = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { Authorization: "Bearer not-a-token" });
  assert.equal(badToken.status, 401, "a bad token is rejected even on discovery calls");

  const prm =await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const asMeta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.ok(asMeta.registration_endpoint && asMeta.code_challenge_methods_supported.includes("S256"));

  // -- Dynamic client registration (rejects non-https redirect)
  const badReg = await fetch(asMeta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(badReg.status, 400);
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const reg = await (
    await fetch(asMeta.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Claude" }) })
  ).json();
  assert.ok(reg.client_id);

  // -- Authorize: login page, wrong password, then success
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authUrl = new URL(asMeta.authorization_endpoint);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${base}/mcp` }).forEach(([k, v]) =>
    authUrl.searchParams.set(k, v)
  );
  const page = await (await fetch(authUrl)).text();
  const reqField = /name="req" value="([^"]+)"/.exec(page)?.[1];
  assert.ok(reqField, "login page must carry the sealed request");
  assert.match(page, /Claude/);
  const submit = (password: string) =>
    fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ req: reqField as string, email: "me@example.com", password })
    });
  const wrong = await submit("nope");
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /Invalid email or password/);
  const ok = await submit("correct-horse");
  assert.equal(ok.status, 302);
  const callback = new URL(ok.headers.get("location") as string);
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get("state"), "xyz");
  const code = callback.searchParams.get("code") as string;

  // -- Token exchange: PKCE enforced, single use
  const token = (body: Record<string, string>) =>
    fetch(asMeta.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const badPkce = await token({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: "wrong" });
  assert.equal(badPkce.status, 400);
  const tokens = await (await token({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier })).json();
  assert.ok(tokens.access_token && tokens.refresh_token && tokens.expires_in > 0);
  const reuse = await token({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier });
  assert.equal(reuse.status, 400, "codes are single-use");
  const refreshed = await (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id })).json();
  assert.ok(refreshed.access_token, "refresh grant works");

  // -- MFA sign-in: password step shows the code form, wrong code is rejected, right code redirects
  const mfaStart = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ req: reqField, email: "mfa@example.com", password: "whatever" })
  });
  const mfaPageHtml = await mfaStart.text();
  const mfaField = /name="mfa" value="([^"]+)"/.exec(mfaPageHtml)?.[1];
  assert.ok(mfaField, "MFA page must carry the sealed challenge");
  assert.ok(!mfaPageHtml.includes("challenge-1"), "Spur's challenge token is never exposed in the page");
  const mfaSubmit = (codeValue: string) =>
    fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ req: reqField as string, mfa: mfaField as string, code: codeValue })
    });
  assert.equal((await mfaSubmit("000000")).status, 401);
  const mfaOk = await mfaSubmit("123456");
  assert.equal(mfaOk.status, 302);
  assert.ok(new URL(mfaOk.headers.get("location") as string).searchParams.get("code"));

  // -- Google sign-in: page offers it, start sets a browser-bound cookie, callback needs that cookie
  assert.match(page, /href="\/oauth\/google\?req=/, "login page offers Continue with Google");
  const googleStart = await fetch(`${base}/oauth/google?req=${encodeURIComponent(reqField)}`, { redirect: "manual" });
  assert.equal(googleStart.status, 302);
  const supabaseAuthorize = new URL(googleStart.headers.get("location") as string);
  assert.equal(supabaseAuthorize.origin + supabaseAuthorize.pathname, `${spurUrl}/auth/v1/authorize`);
  assert.equal(supabaseAuthorize.searchParams.get("provider"), "google");
  assert.equal(supabaseAuthorize.searchParams.get("redirect_to"), `${base}/oauth/google/callback`);
  const googleCookie = (googleStart.headers.get("set-cookie") || "").split(";")[0];
  assert.match(googleCookie, /^spur_mcp_google=/);
  const googleCallback = (query: string, cookie?: string) =>
    fetch(`${base}/oauth/google/callback?${query}`, { redirect: "manual", headers: cookie ? { Cookie: cookie } : {} });
  assert.equal((await googleCallback("code=google-code")).status, 400, "callback without the start cookie is rejected");
  const cancelled = await googleCallback("error=access_denied&error_description=User+cancelled", googleCookie);
  assert.equal(cancelled.status, 400);
  assert.match(await cancelled.text(), /User cancelled/);
  const googleOk = await googleCallback("code=google-code", googleCookie);
  assert.equal(googleOk.status, 302);
  const googleRedirect = new URL(googleOk.headers.get("location") as string);
  assert.equal(googleRedirect.origin + googleRedirect.pathname, redirectUri);
  assert.equal(googleRedirect.searchParams.get("state"), "xyz");
  const exchange = calls.filter(c => c.path === "/auth/v1/token").at(-1);
  assert.equal(createHash("sha256").update(exchange?.body.code_verifier || "").digest("base64url"), supabaseAuthorize.searchParams.get("code_challenge"), "Supabase PKCE verifier matches");
  const googleTokens = await (
    await token({ grant_type: "authorization_code", code: googleRedirect.searchParams.get("code") as string, client_id: reg.client_id, redirect_uri: redirectUri, code_verifier: verifier })
  ).json();
  assert.ok(googleTokens.access_token, "Google sign-in yields MCP tokens");

  // -- MCP session
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } } }));

  const { tools } = await client.listTools();
  const names = tools.map(t => t.name);
  for (const expected of [
    "spur_search_properties",
    "spur_parse_search_query",
    "spur_save_properties",
    "spur_create_postcard_template",
    "spur_update_postcard_template",
    "spur_preview_postcard_campaign",
    "spur_send_postcards",
    "spur_preview_postcard_template",
    "spur_add_postcard_qr_code",
    "spur_remove_postcard_qr_code",
    "spur_list_qr_codes",
    "spur_create_qr_code",
    "spur_update_qr_code",
    "spur_delete_qr_code",
    "spur_get_qr_code_activity",
    "spur_list_images",
    "spur_save_image",
    "spur_upload_image",
    "spur_save_uploaded_image",
    "spur_delete_image",
    "spur_list_letter_templates",
    "spur_get_letter_template",
    "spur_preview_letter_template",
    "spur_create_letter_template",
    "spur_update_letter_template",
    "spur_delete_letter_template",
    "spur_preview_letter_campaign",
    "spur_send_letters",
    "spur_list_message_templates",
    "spur_get_message_template",
    "spur_preview_message_template",
    "spur_preview_message_draft",
    "spur_create_email_template",
    "spur_update_email_template",
    "spur_create_sms_template",
    "spur_update_sms_template",
    "spur_delete_message_template",
    "spur_send_test_email",
    "spur_get_workflow",
    "spur_create_workflow",
    "spur_set_workflow_step_template",
    "spur_set_workflow_active",
    "spur_show_billing_options",
    "spur_top_up_wallet",
    "spur_change_plan",
    "spur_check_payment",
    "spur_manage_billing",
    "spur_set_auto_recharge",
    "search",
    "fetch"
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const searchTool = tools.find(t => t.name === "spur_search_properties") as any;
  assert.equal(searchTool._meta.ui.resourceUri, "ui://spur/property-explorer-v1.html");
  const sendTool = tools.find(t => t.name === "spur_send_postcards") as any;
  assert.equal(sendTool.annotations.destructiveHint, true);
  const sendLettersTool = tools.find(t => t.name === "spur_send_letters") as any;
  assert.equal(sendLettersTool.annotations.destructiveHint, true);
  assert.equal(sendLettersTool._meta.ui.resourceUri, "ui://spur/postcard-preview-v2.html", "the widget's Send button can call spur_send_letters");

  // -- Widget resources
  for (const tool of ["spur_show_billing_options", "spur_top_up_wallet", "spur_change_plan", "spur_check_payment", "spur_manage_billing"]) {
    assert.equal((tools.find(t => t.name === tool) as any)._meta.ui.resourceUri, "ui://spur/billing-v1.html", `${tool} renders the billing widget`);
  }
  assert.equal((tools.find(t => t.name === "spur_change_plan") as any).annotations.destructiveHint, true, "plan switches can charge the saved card");
  assert.equal((tools.find(t => t.name === "spur_set_auto_recharge") as any).annotations.destructiveHint, true);
  const billingWidget = (await client.readResource({ uri: "ui://spur/billing-v1.html" })).contents[0] as any;
  assert.equal(billingWidget.mimeType, "text/html;profile=mcp-app");
  assert.ok(billingWidget.text.includes("window.__SPUR__") && billingWidget.text.includes("spur_top_up_wallet") && billingWidget.text.includes("spur_check_payment"), "billing widget is built");

  for (const uri of ["ui://spur/property-explorer-v1.html", "ui://spur/postcard-preview-v2.html", "ui://spur/message-preview-v1.html"]) {
    const res = await client.readResource({ uri });
    const content = res.contents[0] as any;
    assert.equal(content.mimeType, "text/html;profile=mcp-app");
    assert.ok(content.text.includes("window.__SPUR__") && content.text.length > 10_000, `${uri} should be a built widget`);
    assert.ok(content._meta.ui.csp.resourceDomains.length > 0);
  }
  const mailWidget = (await client.readResource({ uri: "ui://spur/postcard-preview-v2.html" })).contents[0] as any;
  assert.ok(mailWidget.text.includes("pp-address-zone") && mailWidget.text.includes("spur_send_"), "mail widget renders letters and sends either type");

  // -- Map tiles go through the caching proxy with an identifying User-Agent
  const explorer = (await client.readResource({ uri: "ui://spur/property-explorer-v1.html" })).contents[0] as any;
  assert.ok(explorer.text.includes(`${base}/tiles/{z}/{x}/{y}.png`), "widget loads tiles from the proxy");
  assert.ok(explorer._meta.ui.csp.resourceDomains.includes(base), "widget CSP allows the proxy origin");
  assert.ok(!explorer._meta.ui.csp.resourceDomains.includes(spurUrl), "widget never contacts the tile server directly");
  const firstTile = await fetch(`${base}/tiles/3/2/1.png`);
  assert.equal(firstTile.status, 200);
  assert.equal(firstTile.headers.get("content-type"), "image/png");
  assert.equal(firstTile.headers.get("x-cache"), "MISS");
  assert.equal(await firstTile.text(), "png-bytes");
  const secondTile = await fetch(`${base}/tiles/3/2/1.png`);
  assert.equal(secondTile.headers.get("x-cache"), "HIT");
  assert.match(secondTile.headers.get("cache-control") || "", /public, max-age=\d+/);
  assert.equal(tileRequests.length, 1, "cached tile is fetched upstream once");
  assert.match(tileRequests[0].userAgent || "", /^spur-mcp-server\/[\d.]+ \(\+http:\/\/localhost:\d+; ops@example\.com\)$/);
  assert.equal(tileRequests[0].referer, `${base}/`);
  const burst = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/tiles/5/6/7.png`)));
  assert.ok(burst.every(r => r.status === 200));
  assert.equal(tileRequests.length, 2, "concurrent requests for one tile share one upstream fetch");
  assert.equal((await fetch(`${base}/tiles/4/1/1.png`)).status, 404);
  for (const bad of ["3/8/1.png", "20/0/0.png", "3/1/1.jpg", "-1/0/0.png", "1e1/0/0.png"]) {
    assert.equal((await fetch(`${base}/tiles/${bad}`)).status, 400, `${bad} is rejected`);
  }
  assert.equal(tileRequests.length, 3, "invalid coordinates never reach the tile server");

  // -- Search → cards with coordinates for the map
  const search = await client.callTool({ name: "spur_search_properties", arguments: { query: "3 bed houses", location: "Austin, TX" } });
  assert.ok(!search.isError, text(search));
  const cards = (search.structuredContent as any).cards;
  assert.equal(cards[0].lat, 30.25);
  assert.ok(!("allPhotos" in cards[0].listing), "listing payload is compacted");

  // -- Advanced + event filters reach the API with backend field names, and results explain themselves
  const eventSearch = await client.callTool({
    name: "spur_search_properties",
    arguments: {
      location: "Houston, TX",
      listing_status: "forSale",
      max_price: 400000,
      home_type: "multiFamily",
      max_year_built: 1979,
      zip_list: ["77004"],
      only_absentee: true,
      has_3d_tour: true,
      events: ["price_drop", "back_on_market", "delisted"],
      event_within_days: 7,
      event_min_change_pct: 5
    }
  });
  assert.ok(!eventSearch.isError, text(eventSearch));
  const eventBody = calls.filter(c => c.path === "/api/zillow/search").at(-1)!.body;
  assert.deepEqual(
    { ...eventBody, resultsPerPage: undefined },
    {
      location: "Houston, TX", status: "forSale", maxAmount: 400000, homeType: "multiFamily", maxYearBuilt: 1979, zipList: ["77004"],
      onlyAbsentee: true, has3DTour: true, events: ["price_drop", "back_on_market", "delisted"], eventWithinDays: 7, eventMinChangePct: 5,
      resultsPerPage: undefined
    }
  );
  const eventText = text(eventSearch);
  assert.ok(eventText.includes("price_drop (-10%: $300,000 → $270,000)"), eventText);
  assert.ok(eventText.includes("First look at this area"), "baseline notice");
  assert.ok(eventText.includes("delisted only runs in search automations"), "automation-only notice");
  assert.ok(eventText.includes("absentee −3"), "post-filter diagnostics");
  assert.ok(!("eventDetails" in (eventSearch.structuredContent as any).cards[0].listing), "event details are not echoed into save payloads");

  const parsed = await client.callTool({ name: "spur_parse_search_query", arguments: { query: "older duplexes in Houston under 400k that dropped price or came back on market, no condos" } });
  assert.ok(!parsed.isError, text(parsed));
  const parsedArgs = (parsed.structuredContent as any).arguments;
  assert.deepEqual(parsedArgs, {
    location: "Houston, TX", listing_status: "forSale", home_type: "multiFamily", max_price: 400000,
    events: ["price_drop", "back_on_market"], event_within_days: 7, has_3d_tour: true, query: "older duplexes, excluding condos"
  });
  assert.ok(text(parsed).includes("bogusKey"), "unknown parsed keys are reported, not passed on");

  const automation = await client.callTool({
    name: "spur_create_search_automation",
    arguments: {
      name: "Houston distress", location: "Houston, TX", frequency: "daily", run_time: "07:00", listing_status: "forSale",
      events: ["preforeclosure", "price_drop", "delisted"], event_min_change_pct: 10, only_absentee: true, min_beds: 3
    }
  });
  assert.ok(!automation.isError, text(automation));
  const autoBody = calls.filter(c => c.path === "/api/automation/configs").at(-1)!.body;
  assert.equal(autoBody.status, "forSale");
  assert.deepEqual(autoBody.events, ["preforeclosure", "price_drop", "delisted"]);
  assert.equal(autoBody.event_min_change_pct, 10);
  assert.equal(autoBody.only_absentee, true);
  assert.equal(autoBody.min_beds, 3);
  assert.ok(!("listing_status" in autoBody));

  const save = await client.callTool({ name: "spur_save_properties", arguments: { listings: [cards[0].listing] } });
  assert.ok(!save.isError && text(save).includes("prop-111"), text(save));

  // -- Postcard templates: copy a default, then edit with a replacement
  const created = await client.callTool({ name: "spur_create_postcard_template", arguments: { name: "My Just Sold", base_template_id: "tpl-default" } });
  assert.ok(!created.isError, text(created));
  const createdData = created.structuredContent as any;
  assert.match(createdData.back_html, /Hi Jordan/, "template preview uses sample merge data");
  const artwork = (created._meta as any)?.["spur/postcard_artwork"];
  assert.ok(artwork?.front_html.includes(`src="data:image/png;base64,${Buffer.from("fake-png").toString("base64")}"`), "template images are inlined for the widget");
  assert.ok(artwork.front_html.includes(`src="data:image/png;base64,${Buffer.from("fake-qr").toString("base64")}"`), "QR placeholder shows the preview image");
  assert.ok(!createdData.front_html.includes("data:image"), "inlined images stay out of structuredContent");
  const newId = createdData.template.id;

  const editDefault = await client.callTool({ name: "spur_update_postcard_template", arguments: { template_id: "tpl-default", name: "x" } });
  assert.equal(editDefault.isError, true, "defaults are not editable");

  const edited = await client.callTool({
    name: "spur_update_postcard_template",
    arguments: { template_id: newId, replacements: [{ side: "front", find: "Just Sold!", replace: "Just Listed!" }] }
  });
  assert.ok(!edited.isError, text(edited));
  assert.match((edited.structuredContent as any).front_html, /Just Listed!/);

  const ambiguous = await client.callTool({ name: "spur_update_postcard_template", arguments: { template_id: newId, replacements: [{ side: "front", find: "h1", replace: "h2" }] } });
  assert.equal(ambiguous.isError, true, "non-unique replacement must fail without saving");

  // -- Preview → send guardrails
  const preview = await client.callTool({ name: "spur_preview_postcard_campaign", arguments: { template_id: newId, owner_ids: ["own-1", "own-2"] } });
  assert.ok(!preview.isError, text(preview));
  const p = preview.structuredContent as any;
  assert.equal(p.recipients.mailable, 1);
  assert.equal(p.recipients.no_address, 1);
  assert.match(p.back_html, /Hi Pat, call 512-555-0199/, "campaign preview uses the first recipient's data");
  assert.equal(p.cost.estimated_charge_usd, 0.99);

  const noConfirm = await client.callTool({ name: "spur_send_postcards", arguments: { confirmation_token: p.confirmation_token } });
  assert.equal(noConfirm.isError, true, "confirm=true is required");
  const tampered = await client.callTool({ name: "spur_send_postcards", arguments: { confirmation_token: p.confirmation_token.slice(0, -4) + "AAAA", confirm: true } });
  assert.equal(tampered.isError, true, "tampered tokens are rejected");
  assert.ok(!calls.some(c => c.path === "/api/direct-mail/orders/bulk"), "nothing mailed yet");

  const sent = await client.callTool({ name: "spur_send_postcards", arguments: { confirmation_token: p.confirmation_token, confirm: true } });
  assert.ok(!sent.isError, text(sent));
  const order = calls.find(c => c.path === "/api/direct-mail/orders/bulk");
  assert.deepEqual(order?.body.owner_ids, ["own-1"], "only mailable owners are sent");
  assert.equal(order?.body.template_id, newId);
  assert.equal(order?.body.return_address_id, "ra-1");

  const lastBulk = () => calls.filter(c => c.path === "/api/direct-mail/orders/bulk").at(-1)!.body;
  const lastTemplatePost = () => calls.filter(c => c.method === "POST" && c.path === "/api/direct-mail/templates").at(-1)!.body;

  // -- Postcards in all three sizes: blank canvas → design → preview (size-priced) → approve → send
  const sizes = { "6x4": { px: "1875px", inches: [6, 4], price: 0.99 }, "6x9": { px: "2775px", inches: [9, 6], price: 1.19 }, "6x11": { px: "3375px", inches: [11, 6], price: 1.39 } } as const;
  for (const [size, spec] of Object.entries(sizes)) {
    const blank = await client.callTool({ name: "spur_create_postcard_template", arguments: { name: `Blank ${size}`, start_from_blank: true, size } });
    assert.ok(!blank.isError, text(blank));
    const posted = lastTemplatePost();
    assert.equal(posted.size, size);
    assert.ok(posted.front_html.includes(`width: ${spec.px}`) && posted.back_html.includes(`width: ${spec.px}`), `${size} blank canvas is sized at 300 px/in with bleed`);
    assert.ok(posted.back_html.includes('class="message"'), "blank back keeps a message column clear of the address area");
    const [messageW, messageH] = { "6x4": [563, 975], "6x9": [1463, 1575], "6x11": [2063, 1575] }[size];
    assert.ok(posted.back_html.includes(`left: 75px; top: 75px; width: ${messageW}px; height: ${messageH}px;`), "message column stops left of the address block and above the barcode strip");
    assert.equal(posted.metadata.started_from, "blank");
    const blankData = blank.structuredContent as any;
    assert.deepEqual(blankData.template.inches, spec.inches);
    assert.match(text(blank), /canvas is empty/);

    const designed = await client.callTool({
      name: "spur_update_postcard_template",
      arguments: {
        template_id: blankData.template.id,
        replacements: [
          { side: "front", find: '<div class="safe"></div>', replace: '<div class="safe"><h1>We buy houses</h1></div>' },
          { side: "back", find: '<div class="message"></div>', replace: '<div class="message">Hi {{owner_first_name}}</div>' }
        ]
      }
    });
    assert.ok(!designed.isError, text(designed));
    assert.match((designed.structuredContent as any).back_html, /Hi Jordan/);

    const pcPreview = await client.callTool({ name: "spur_preview_postcard_campaign", arguments: { template_id: blankData.template.id, owner_ids: ["own-1"] } });
    assert.ok(!pcPreview.isError, text(pcPreview));
    const pc = pcPreview.structuredContent as any;
    assert.equal(pc.template.size, size);
    assert.deepEqual(pc.clear_zone.zones.map((z: any) => z.id), ["postage", "address", "barcode"], "widget gets the USPS clear zones to check");
    assert.deepEqual(pc.clear_zone.bleed_inches, [spec.inches[0] + 0.25, spec.inches[1] + 0.25]);
    assert.match(text(pcPreview), /USPS clear zone \(back\): Postage: x [\d.]+–[\d.]+in/, "the assistant is told exactly where the zone is");
    assert.match(text(pcPreview), /don't mail a design with clear-zone overlaps/);
    assert.equal(pc.cost.estimated_charge_usd, spec.price, `${size} is priced at its plan variant`);
    assert.match(pc.front_html, /We buy houses/);
    assert.match(pc.back_html, /Hi Pat/, "campaign preview uses the recipient's data");

    const pcSent = await client.callTool({ name: "spur_send_postcards", arguments: { confirmation_token: pc.confirmation_token, confirm: true } });
    assert.ok(!pcSent.isError, text(pcSent));
    assert.deepEqual({ type: lastBulk().type, size: lastBulk().size, template_id: lastBulk().template_id }, { type: "postcard", size, template_id: blankData.template.id });
  }

  // -- Postcard redesign from the Spur gallery (copy + resize); gallery originals stay read-only
  const pcList = await client.callTool({ name: "spur_list_postcard_templates", arguments: {} });
  assert.match(text(pcList), /## Spur gallery[\s\S]*6x4__open_house/);
  const galleryPc = await client.callTool({ name: "spur_preview_postcard_template", arguments: { template_id: "6x4__open_house" } });
  assert.ok(!galleryPc.isError, text(galleryPc));
  assert.match((galleryPc.structuredContent as any).back_html, /Stop by, Jordan/);
  assert.match(text(galleryPc), /first copy it/);
  assert.equal((await client.callTool({ name: "spur_update_postcard_template", arguments: { template_id: "6x4__open_house", name: "x" } })).isError, true, "gallery postcards are not editable");
  assert.equal(
    (await client.callTool({ name: "spur_preview_postcard_campaign", arguments: { template_id: "6x4__open_house", owner_ids: ["own-1"] } })).isError,
    true,
    "gallery postcards must be copied before mailing"
  );
  const redesigned = await client.callTool({ name: "spur_create_postcard_template", arguments: { name: "Open House XL", base_template_id: "6x4__open_house", size: "6x11" } });
  assert.ok(!redesigned.isError, text(redesigned));
  assert.equal(lastTemplatePost().size, "6x11");
  assert.equal(lastTemplatePost().metadata.copied_from, "6x4__open_house");
  assert.match(text(redesigned), /Resized from 6x4/);
  assert.equal(
    (await client.callTool({ name: "spur_create_postcard_template", arguments: { name: "x", base_template_id: "6x4__open_house", start_from_blank: true } })).isError,
    true,
    "blank and copy are exclusive"
  );

  // -- QR codes: manage parent codes, place the per-recipient placeholder on a back, guard sends
  const lastTemplatePut = () => calls.filter(c => c.method === "PUT" && c.path.startsWith("/api/direct-mail/templates/")).at(-1)!.body;
  const qrCreated = await client.callTool({ name: "spur_create_qr_code", arguments: { name: "Spring offer", destination_url: "acme.example/spring" } });
  assert.ok(!qrCreated.isError, text(qrCreated));
  const qrId = (qrCreated.structuredContent as any).qr_code.id;
  assert.equal((qrCreated.structuredContent as any).qr_code.destination_url, "https://acme.example/spring");
  const qrEdited = await client.callTool({ name: "spur_update_qr_code", arguments: { qr_code_id: qrId, foreground_color: "#0f766e" } });
  assert.ok(!qrEdited.isError, text(qrEdited));
  assert.deepEqual(calls.filter(c => c.method === "PUT" && c.path === `/api/direct-mail/qr-codes/${qrId}`).at(-1)!.body, { foreground_color: "#0f766e" });
  assert.equal((await client.callTool({ name: "spur_update_qr_code", arguments: { qr_code_id: qrId, foreground_color: "teal" } })).isError, true, "colors must be hex");

  // No QR slot on a blank back: bottom-right of the message area, clear of the USPS zones
  const qrCard = await client.callTool({ name: "spur_create_postcard_template", arguments: { name: "QR card", start_from_blank: true, size: "6x4" } });
  const qrCardId = (qrCard.structuredContent as any).template.id;
  const qrAdded = await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: qrCardId, qr_code_id: qrId } });
  assert.ok(!qrAdded.isError, text(qrAdded));
  let back = lastTemplatePut().back_html as string;
  assert.ok(back.includes(`src="{{qrUrl}}"`) && back.includes(`data-spur-qr-merge="true"`) && back.includes(`data-spur-parent-qr-id="${qrId}"`), "writes the editor's placeholder linked to the parent");
  assert.ok(back.includes("left:18%;top:58.824%;width:16%;"), "1in square at x 1.125in, y 2.5in of the 6.25×4.25in bleed");
  assert.ok(back.indexOf("data-spur-qr-wrap") < back.lastIndexOf("</div>") && !back.includes("data-spur-qr-style"), "inside the positioned .postcard root, no extra CSS needed");
  assert.match(text(qrAdded), /message area at x 1\.125in, y 2\.5in/);
  assert.match(text(qrAdded), /QR code: Spring offer → https:\/\/acme\.example\/spring/);
  const qrArt = (qrAdded._meta as any)["spur/postcard_artwork"];
  assert.ok(qrArt.back_html.includes(`src="data:image/png;base64,${Buffer.from("fake-qr").toString("base64")}"`), "preview shows the parent's QR image");

  // Moving it replaces, never duplicates; bad spots are refused without saving
  const putsBefore = calls.filter(c => c.method === "PUT").length;
  assert.match(text(await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: qrCardId, qr_code_id: qrId, x_inches: 4, y_inches: 2 } })), /address block/);
  assert.match(text(await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: qrCardId, qr_code_id: qrId, size_inches: 2 } })), /doesn't fit/);
  assert.equal((await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: qrCardId, qr_code_id: "qr-missing" } })).isError, true);
  assert.equal(calls.filter(c => c.method === "PUT").length, putsBefore, "refused placements save nothing");
  const moved = await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: qrCardId, qr_code_id: qrId, position: "top_left", size_inches: 0.75 } });
  assert.match(text(moved), /Replaced the QR/);
  back = lastTemplatePut().back_html;
  assert.equal(back.split("data-spur-qr-merge=").length - 1, 1, "one QR per card");
  assert.ok(back.includes("left:4%;top:5.882%;width:12%;"));

  // A design's QR slot is filled in place
  const slotted = await client.callTool({
    name: "spur_create_postcard_template",
    arguments: {
      name: "Slot card",
      size: "6x4",
      front_html: "<html><body><h1>Hi</h1></body></html>",
      back_html: '<html><head><style>.postcard{width:1875px;height:1275px}</style></head><body><div class="postcard"><p>Scan me</p><div class="qr-box" style="width:300px;height:300px"><span>QR</span></div></div></body></html>'
    }
  });
  const slotId = (slotted.structuredContent as any).template.id;
  assert.match(text(slotted), /QR code box with no code in it/, "an empty QR box is pointed out so it gets filled");
  const slotAdded = await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: slotId, qr_code_id: qrId } });
  assert.ok(!slotAdded.isError, text(slotAdded));
  assert.match(text(slotAdded), /QR slot \(\.qr-box\)/);
  assert.match(lastTemplatePut().back_html, /<div class="qr-box" style="width:300px;height:300px"><img src="\{\{qrUrl\}\}"[^>]*data-spur-parent-qr-id="qr-\d+"[^>]*><\/div><\/div>/, "slot content replaced by the QR");
  const corner = await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: slotId, qr_code_id: qrId, position: "bottom_left" } });
  assert.ok(!corner.isError, text(corner));
  assert.ok(lastTemplatePut().back_html.includes('<style data-spur-qr-style="true">.postcard{position:relative;}</style>'), "unpositioned roots get a containing block");
  assert.ok(lastTemplatePut().back_html.includes('<div class="qr-box" style="width:300px;height:300px"></div>'), "the old slot QR is gone");
  assert.equal((await client.callTool({ name: "spur_add_postcard_qr_code", arguments: { template_id: "6x4__open_house", qr_code_id: qrId } })).isError, true, "gallery designs must be copied first");

  // Sends: a linked QR previews fine; unlinked or deleted parents are stopped before a token exists
  const qrCampaign = await client.callTool({ name: "spur_preview_postcard_campaign", arguments: { template_id: slotId, owner_ids: ["own-1"] } });
  assert.ok(!qrCampaign.isError, text(qrCampaign));
  assert.match(text(qrCampaign), /QR code: Spring offer/);
  const unlinked = await client.callTool({
    name: "spur_create_postcard_template",
    arguments: { name: "Unlinked", size: "6x4", front_html: "<html><body>x</body></html>", back_html: '<html><body><img src="{{qrUrl}}" data-spur-qr-merge="true"></body></html>' }
  });
  assert.match(text(unlinked), /isn't linked to a QR code/, "template previews warn about an unlinked QR");
  const unlinkedSend = await client.callTool({ name: "spur_preview_postcard_campaign", arguments: { template_id: (unlinked.structuredContent as any).template.id, owner_ids: ["own-1"] } });
  assert.ok(unlinkedSend.isError && !(unlinkedSend.structuredContent as any)?.confirmation_token, "no token for a card that would print a blank QR");

  const qrList = await client.callTool({ name: "spur_list_qr_codes", arguments: {} });
  assert.match(text(qrList), /Spring offer.*on "QR card", "Slot card"/);
  const blocked = await client.callTool({ name: "spur_delete_qr_code", arguments: { qr_code_id: qrId, confirm: true } });
  assert.ok(blocked.isError && /still print/.test(text(blocked)), "in-use codes aren't deleted");
  for (const id of [qrCardId, slotId]) {
    const removed = await client.callTool({ name: "spur_remove_postcard_qr_code", arguments: { template_id: id } });
    assert.ok(!removed.isError, text(removed));
    assert.ok(!lastTemplatePut().back_html.includes("qrUrl") && !lastTemplatePut().back_html.includes("data-spur-qr-wrap"));
  }
  assert.ok(lastTemplatePut().back_html.includes("data-spur-qr-style") === false, "removal also drops the injected CSS");
  assert.ok(!(await client.callTool({ name: "spur_delete_qr_code", arguments: { qr_code_id: qrId, confirm: true } })).isError);

  const activity = await client.callTool({ name: "spur_get_qr_code_activity", arguments: { qr_code_id: "qr-seed" } });
  assert.ok(!activity.isError, text(activity));
  assert.match(text(activity), /Postcard scans: 3/);
  assert.match(text(activity), /Pat Lee \(owner_id: own-1\), 9 Oak St: 3 scans/);
  assert.ok(!text(activity).includes("Quiet Owner"), "only recipients who scanned are listed");

  // -- Images: upload from the device (widget), save from a link, use in postcard/letter/email, delete safely
  const uploadTool = tools.find(t => t.name === "spur_upload_image") as any;
  assert.equal(uploadTool._meta.ui.resourceUri, "ui://spur/image-upload-v1.html");
  const uploader = (await client.readResource({ uri: "ui://spur/image-upload-v1.html" })).contents[0] as any;
  assert.ok(uploader.text.includes("spur_save_uploaded_image") && uploader.text.length > 10_000, "uploader widget is built");
  const opened = await client.callTool({ name: "spur_upload_image", arguments: { purpose: "Logo for the postcard back" } });
  assert.equal((opened.structuredContent as any).purpose, "Logo for the postcard back");

  const uploaded = await client.callTool({ name: "spur_save_uploaded_image", arguments: { filename: "Acme Logo (final).PNG", data_base64: TINY_PNG.toString("base64") } });
  assert.ok(!uploaded.isError, text(uploaded));
  const logo = (uploaded.structuredContent as any).image;
  assert.equal(logo.filename, "Acme-Logo-final.png", "storage-safe name with the real extension");
  assert.equal(logo.mime_type, "image/png");
  assert.ok(storedObjects.get(`user-assets/user-1/1700000000000-Acme-Logo-final.png`)?.body.equals(TINY_PNG), "bytes reach storage unchanged through the signed URL");
  const uploadPut = calls.filter(c => c.method === "PUT" && c.path.startsWith("/storage/")).at(-1)!;
  assert.ok(!uploadPut.auth, "the user's Spur token never goes to storage");

  const callsBefore = calls.length;
  const notImage = await client.callTool({ name: "spur_save_uploaded_image", arguments: { filename: "photo.png", data_base64: Buffer.from("<html>hi</html>").toString("base64") } });
  assert.ok(notImage.isError && /isn't a JPG, PNG/.test(text(notImage)), "content is checked, not the file name");
  assert.ok(!calls.slice(callsBefore).some(c => c.path === "/api/assets/upload-url"), "rejected files never reach storage");

  const fromLink = await client.callTool({ name: "spur_save_image", arguments: { url: `${spurUrl}/media/logo.png`, filename: "headshot" } });
  assert.ok(!fromLink.isError, text(fromLink));
  assert.equal((fromLink.structuredContent as any).image.filename, "headshot.png");
  assert.match(text(await client.callTool({ name: "spur_save_image", arguments: { url: `${spurUrl}/media/page.html` } })), /Couldn't download an image/);
  assert.equal((await client.callTool({ name: "spur_save_image", arguments: { url: "http://localhost:1/x.png" } })).isError, true, "private hosts are refused");

  const library = await client.callTool({ name: "spur_list_images", arguments: {} });
  assert.match(text(library), /headshot\.png[\s\S]*Acme-Logo-final\.png/, "newest first");
  assert.ok(text(library).includes(logo.url));

  // Saved images render in every preview (inlined for the widget) and stay as URLs in the saved HTML
  const logoData = `data:image/png;base64,${TINY_PNG.toString("base64")}`;
  const withLogo = await client.callTool({
    name: "spur_create_postcard_template",
    arguments: { name: "Logo card", size: "6x4", front_html: `<html><body><img src="${logo.url}" alt="Acme"></body></html>`, back_html: "<html><body><p>Hi</p></body></html>" }
  });
  assert.ok(!withLogo.isError, text(withLogo));
  assert.ok((withLogo._meta as any)["spur/postcard_artwork"].front_html.includes(logoData), "postcard preview shows the saved image");
  assert.ok(lastTemplatePost().front_html.includes(logo.url));
  const logoLetter = await client.callTool({
    name: "spur_create_letter_template",
    arguments: { name: "Logo letter", letter_type: "insert_blank_page", html: `<html><body><div class="letter"><img src="${logo.url}" alt="Acme"><p>Dear {{owner_first_name}}</p></div></body></html>` }
  });
  assert.ok(!logoLetter.isError, text(logoLetter));
  assert.ok((logoLetter._meta as any)["spur/postcard_artwork"].html.includes(logoData), "letter preview shows the saved image");
  const logoEmail = await client.callTool({ name: "spur_preview_message_draft", arguments: { channel: "email", subject: "Hello", html: `<html><body><img src="${logo.url}" alt="Acme" width="120"><p>Hi</p></body></html>` } });
  assert.ok((logoEmail._meta as any)["spur/message_html"].html.includes(logoData), "email preview shows the saved image");

  const inUse = await client.callTool({ name: "spur_delete_image", arguments: { image_id: logo.id, confirm: true } });
  assert.ok(inUse.isError && /postcard "Logo card"/.test(text(inUse)) && /letter "Logo letter"/.test(text(inUse)), "images used by templates aren't deleted");
  const headshotId = (fromLink.structuredContent as any).image.id;
  assert.ok(!(await client.callTool({ name: "spur_delete_image", arguments: { image_id: headshotId, confirm: true } })).isError);
  assert.ok(!assets.some(a => a.id === headshotId));

  // -- Letters, both types: blank page → write → preview (type layout + price) → approve → send
  const letterTypes = {
    top_first_page: { tag: "Top First Page", price: 1.39 },
    insert_blank_page: { tag: "Insert Blank Page", price: 1.78 }
  } as const;
  const letterTokens: string[] = [];
  for (const [letterType, spec] of Object.entries(letterTypes)) {
    const blank = await client.callTool({ name: "spur_create_letter_template", arguments: { name: `Blank ${letterType}`, letter_type: letterType, start_from_blank: true } });
    assert.ok(!blank.isError, text(blank));
    const posted = lastTemplatePost();
    assert.deepEqual({ type: posted.type, size: posted.size, tag: posted.letter_template_tag, placement: posted.metadata.address_placement }, { type: "letter", size: "us_letter", tag: spec.tag, placement: letterType });
    assert.ok(posted.html_content.includes("@page { size: 8.5in 11in"), "blank letter is one US Letter page");
    assert.equal(posted.html_content.includes('class="address-zone"'), letterType === "top_first_page", "only top_first_page reserves the address band");
    const blankData = blank.structuredContent as any;
    assert.equal(blankData.mail_type, "letter");
    assert.equal(blankData.letter.type, letterType);
    assert.ok(blankData.html.includes(`<!--placement:${letterType}-->`), "preview renders in the letter type's layout");
    assert.ok((blank._meta as any)?.["spur/postcard_artwork"]?.html, "letter artwork reaches the widget");

    const written = await client.callTool({
      name: "spur_update_letter_template",
      arguments: { template_id: blankData.template.id, replacements: [{ find: "<p></p>", replace: "<p>I'd like to make an offer on {{property_address}}.</p>" }] }
    });
    assert.ok(!written.isError, text(written));
    assert.match((written.structuredContent as any).html, /offer on 1428 Elm Street/);

    const ltPreview = await client.callTool({
      name: "spur_preview_letter_campaign",
      arguments: { template_id: blankData.template.id, owner_ids: ["own-1", "own-2"], color: false, double_sided: true }
    });
    assert.ok(!ltPreview.isError, text(ltPreview));
    const lt = ltPreview.structuredContent as any;
    assert.equal(lt.recipients.mailable, 1);
    assert.match(lt.html, /Dear Pat/, "campaign preview uses the recipient's data");
    assert.equal(lt.cost.estimated_charge_usd, spec.price, `${letterType} price includes any inserted page`);
    assert.deepEqual(lt.print, { color: false, double_sided: true });
    letterTokens.push(lt.confirmation_token);

    assert.equal((await client.callTool({ name: "spur_send_letters", arguments: { confirmation_token: lt.confirmation_token } })).isError, true, "confirm=true is required");
    const bulkBefore = calls.filter(c => c.path === "/api/direct-mail/orders/bulk").length;
    assert.equal(
      (await client.callTool({ name: "spur_send_postcards", arguments: { confirmation_token: lt.confirmation_token, confirm: true } })).isError,
      true,
      "a letter token can't mail postcards"
    );
    assert.equal(calls.filter(c => c.path === "/api/direct-mail/orders/bulk").length, bulkBefore, "rejected tokens mail nothing");

    const ltSent = await client.callTool({ name: "spur_send_letters", arguments: { confirmation_token: lt.confirmation_token, confirm: true } });
    assert.ok(!ltSent.isError, text(ltSent));
    assert.match(text(ltSent), /Queued 1 letters/);
    const body = lastBulk();
    assert.deepEqual(
      { type: body.type, template_id: body.template_id, owner_ids: body.owner_ids, size: body.size, address_placement: body.address_placement, color: body.color, double_sided: body.double_sided },
      { type: "letter", template_id: blankData.template.id, owner_ids: ["own-1"], size: "us_letter", address_placement: letterType, color: false, double_sided: true }
    );
  }
  assert.equal(
    (await client.callTool({ name: "spur_send_letters", arguments: { confirmation_token: p.confirmation_token, confirm: true } })).isError,
    true,
    "a postcard token can't mail letters"
  );

  // -- Letter redesign from the gallery: keeps its type, or switches with a warning; type edits reach the backend
  const ltList = await client.callTool({ name: "spur_list_letter_templates", arguments: { letter_type: "insert_blank_page" } });
  assert.match(text(ltList), /\*\*Expired Listing\*\* \(template_id: letter-02-expired-listing\) — Insert Blank Page/);
  const ltGet = await client.callTool({ name: "spur_get_letter_template", arguments: { template_id: "letter-02-expired-listing" } });
  assert.match(text(ltGet), /your listing expired/);
  const kept = await client.callTool({ name: "spur_create_letter_template", arguments: { name: "My Expired", base_template_id: "letter-02-expired-listing" } });
  assert.ok(!kept.isError, text(kept));
  assert.equal(lastTemplatePost().letter_template_tag, "Insert Blank Page");
  const keptId = (kept.structuredContent as any).template.id;
  const switched = await client.callTool({ name: "spur_create_letter_template", arguments: { name: "My Expired (window)", base_template_id: "letter-02-expired-listing", letter_type: "top_first_page" } });
  assert.equal(lastTemplatePost().letter_template_tag, "Top First Page");
  assert.match(text(switched), /check the address area/);
  const retyped = await client.callTool({ name: "spur_update_letter_template", arguments: { template_id: keptId, letter_type: "top_first_page" } });
  assert.ok(!retyped.isError, text(retyped));
  const put = calls.filter(c => c.method === "PUT" && c.path === `/api/direct-mail/templates/${keptId}`).at(-1)!.body;
  assert.deepEqual({ tag: put.letter_template_tag, placement: put.metadata.address_placement }, { tag: "Top First Page", placement: "top_first_page" });
  assert.equal((retyped.structuredContent as any).letter.type, "top_first_page");
  assert.equal((await client.callTool({ name: "spur_update_letter_template", arguments: { template_id: "letter-02-expired-listing", name: "x" } })).isError, true, "gallery letters are not editable");
  assert.equal(
    (await client.callTool({ name: "spur_preview_postcard_template", arguments: { template_id: keptId } })).isError,
    true,
    "a letter can't be previewed as a postcard"
  );

  // -- Email templates: blank layout → write → inbox preview (sample + real owner) → test send to self
  const emailTool = tools.find(t => t.name === "spur_create_email_template") as any;
  assert.equal(emailTool._meta.ui.resourceUri, "ui://spur/message-preview-v1.html");
  const emailBlank = await client.callTool({ name: "spur_create_email_template", arguments: { name: "Cash offer", subject: "About {{property_address}}", start_from_blank: true } });
  assert.ok(!emailBlank.isError, text(emailBlank));
  const eb = emailBlank.structuredContent as any;
  assert.equal(eb.channel, "email");
  assert.equal(eb.subject, "About 1428 Elm Street", "subject is rendered with sample data");
  assert.deepEqual(eb.from, { name: "Alex at Acme", email: "alex@acme.example" });
  assert.match(eb.snippet, /Preheader/, "the hidden preheader is the inbox snippet");
  assert.ok(!("html" in eb), "rendered HTML stays out of structuredContent");
  const ebHtml = (emailBlank._meta as any)?.["spur/message_html"]?.html as string;
  assert.match(ebHtml, /Hi Jordan,/, "widget gets the rendered HTML");
  assert.ok(eb.unresolved_fields.includes("company_name"), "empty merge fields are reported");
  assert.match(text(emailBlank), /send_email step/, "result explains how to use it in automations");
  const emailId = eb.template.id;
  const emailPost = calls.filter(c => c.method === "POST" && c.path === "/api/communication/templates").at(-1)!.body;
  assert.deepEqual({ type: emailPost.template_type, body: emailPost.body }, { type: "email", body: "" }, "plain text is left for the backend to generate");
  assert.match(emailPost.html_content, /role="presentation"/);

  const emailWritten = await client.callTool({
    name: "spur_update_email_template",
    arguments: { template_id: emailId, replacements: [{ target: "html", find: '<p style="margin:0 0 16px;"></p>', replace: '<p style="margin:0 0 16px;">We can make a cash offer on {{property_address}}.</p>' }] }
  });
  assert.ok(!emailWritten.isError, text(emailWritten));
  const emailPut = calls.filter(c => c.method === "PUT" && c.path === `/api/communication/templates/${emailId}`).at(-1)!.body;
  assert.match(emailPut.html_content, /cash offer on \{\{property_address\}\}/);
  assert.equal(emailPut.body, "", "generated plain text is regenerated when the HTML changes");
  assert.match(text(emailWritten), /plain text \(regenerated\)/);
  const ambiguousEmail = await client.callTool({ name: "spur_update_email_template", arguments: { template_id: emailId, replacements: [{ target: "html", find: "<td", replace: "<th" }] } });
  assert.equal(ambiguousEmail.isError, true, "non-unique email replacement fails without saving");

  const handText = await client.callTool({ name: "spur_update_email_template", arguments: { template_id: emailId, text_body: "Hand-written text {{owner_first_name}}" } });
  assert.ok(!handText.isError, text(handText));
  await client.callTool({ name: "spur_update_email_template", arguments: { template_id: emailId, replacements: [{ target: "html", find: "cash offer", replace: "fair cash offer" }] } });
  assert.equal(
    calls.filter(c => c.method === "PUT" && c.path === `/api/communication/templates/${emailId}`).at(-1)!.body.body,
    "Hand-written text {{owner_first_name}}",
    "hand-written plain text survives HTML edits"
  );

  const forOwner = await client.callTool({ name: "spur_preview_message_template", arguments: { template_id: emailId, owner_id: "own-1" } });
  assert.ok(!forOwner.isError, text(forOwner));
  assert.match((forOwner._meta as any)["spur/message_html"].html, /Hi Pat,/, "preview with a real owner's data");
  assert.equal((forOwner.structuredContent as any).sample.label, "Pat Lee");

  const draft = await client.callTool({
    name: "spur_preview_message_draft",
    arguments: { channel: "email", subject: "x".repeat(80), html: '<html><body><img src="/logo.png"><p>Hi {{owner_frist_name}}</p></body></html>' }
  });
  assert.ok(!draft.isError, text(draft));
  const dw = (draft.structuredContent as any).warnings.join("\n");
  for (const re of [/most inboxes cut it off/, /absolute https/, /no alt text/, /No opt-out line/, /owner_frist_name/]) assert.match(dw, re);
  assert.equal((draft.structuredContent as any).template.saved, false);
  assert.ok(!calls.some(c => c.method === "POST" && c.path === "/api/communication/templates" && c.body.subject?.startsWith("xxx")), "drafts are not saved");

  assert.equal((await client.callTool({ name: "spur_send_test_email", arguments: { template_id: emailId } })).isError, true, "test send needs confirm");
  const tested = await client.callTool({ name: "spur_send_test_email", arguments: { template_id: emailId, confirm: true } });
  assert.ok(!tested.isError, text(tested));
  const testBody = calls.find(c => c.path === "/api/email-senders/send-test")!.body;
  assert.deepEqual({ sender: testBody.sender_id, to: testBody.to_email }, { sender: "es-1", to: undefined }, "tests go to the user's own inbox from the default sender");
  assert.match(testBody.html, /fair cash offer on 1428 Elm Street/);

  // -- SMS templates: segments, Unicode, links without fallback
  const sms = await client.callTool({ name: "spur_create_sms_template", arguments: { name: "Follow up", text: "Hi {{owner_first_name}} 🏡 see https://acme.example/offer" } });
  assert.ok(!sms.isError, text(sms));
  const sd = sms.structuredContent as any;
  assert.equal(sd.body, "Hi Jordan 🏡 see https://acme.example/offer");
  assert.equal(sd.stats.encoding, "Unicode (UCS-2)");
  assert.equal(sd.stats.segments, 1);
  assert.match(sd.warnings.join("\n"), /fallback_body/);
  assert.match(sd.warnings.join("\n"), /No opt-out/);
  const smsId = sd.template.id;
  const smsEdit = await client.callTool({
    name: "spur_update_sms_template",
    arguments: { template_id: smsId, fallback_body: "Hi {{owner_first_name}}, reply YES for an offer. Reply STOP to opt out.", replacements: [{ target: "text", find: " 🏡", replace: "" }] }
  });
  assert.ok(!smsEdit.isError, text(smsEdit));
  assert.equal((smsEdit.structuredContent as any).stats.encoding, "GSM-7");
  assert.equal((smsEdit.structuredContent as any).fallback_body, "Hi Jordan, reply YES for an offer. Reply STOP to opt out.");
  assert.equal((await client.callTool({ name: "spur_update_sms_template", arguments: { template_id: emailId, text: "x" } })).isError, true, "an email template can't be edited as SMS");
  const messageList = await client.callTool({ name: "spur_list_message_templates", arguments: {} });
  assert.match(text(messageList), /## Email[\s\S]*Cash offer[\s\S]*## SMS[\s\S]*First touch/);

  // -- Templates drive automations: build a workflow, swap a step's template, activate only with approval
  const wrongChannel = await client.callTool({ name: "spur_create_workflow", arguments: { name: "Bad", steps: [{ type: "send_email", template_id: smsId }] } });
  assert.equal(wrongChannel.isError, true, "an SMS template can't fill an email step");
  const wf = await client.callTool({
    name: "spur_create_workflow",
    arguments: {
      name: "Absentee sequence",
      steps: [
        { type: "send_sms", template_id: "ct-sms-1" },
        { type: "wait", days: 2 },
        { type: "send_email", template_id: emailId },
        { type: "wait", days: 5 },
        { type: "send_direct_mail", template_id: newId }
      ]
    }
  });
  assert.ok(!wf.isError, text(wf));
  const wfPost = calls.filter(c => c.method === "POST" && c.path === "/api/outreach/workflows").at(-1)!.body;
  assert.deepEqual(
    { active: wfPost.is_active, types: wfPost.steps.map((s: any) => s.type) },
    { active: false, types: ["send_sms", "wait", "send_email", "wait", "send_direct_mail"] },
    "workflows are created inactive with the steps in order"
  );
  assert.deepEqual(wfPost.steps[2].config, { template_id: emailId, template_name: "Cash offer", template_source: "communication", send_as_reply: false });
  assert.deepEqual(
    { source: wfPost.steps[4].config.template_source, mail: wfPost.steps[4].config.mail_type, size: wfPost.steps[4].config.postcard_size },
    { source: "direct_mail", mail: "postcard", size: "6x4" },
    "direct-mail steps record the template store like the app's builder"
  );
  assert.deepEqual(wfPost.steps[1].config, { days: 2, hours: 0 });
  const wfId = (wf.structuredContent as any).workflow_id;
  assert.match(text(wf), /Send SMS: "First touch"/);

  const swap = await client.callTool({ name: "spur_set_workflow_step_template", arguments: { workflow_id: wfId, step_id: `${wfId}-s1`, template_id: smsId } });
  assert.ok(!swap.isError, text(swap));
  const wfPut = calls.filter(c => c.method === "PUT" && c.path === `/api/outreach/workflows/${wfId}`).at(-1)!.body;
  assert.equal(wfPut.steps.length, 5, "every step is sent back so none are deleted");
  assert.equal(wfPut.steps[0].config.template_id, smsId);
  assert.equal(wfPut.steps[2].config.template_id, emailId, "other steps are untouched");
  assert.equal(
    (await client.callTool({ name: "spur_set_workflow_step_template", arguments: { workflow_id: wfId, step_id: `${wfId}-s2`, template_id: smsId } })).isError,
    true,
    "wait steps don't take templates"
  );
  const got = await client.callTool({ name: "spur_get_workflow", arguments: { workflow_id: wfId } });
  assert.match(text(got), /1\. Send SMS: "Follow up"/);

  assert.equal((await client.callTool({ name: "spur_set_workflow_active", arguments: { workflow_id: wfId, active: true } })).isError, true, "activating needs approval");
  assert.ok(!calls.some(c => c.path === `/api/outreach/workflows/${wfId}/toggle`), "nothing activated without approval");
  const activated = await client.callTool({ name: "spur_set_workflow_active", arguments: { workflow_id: wfId, active: true, confirm: true } });
  assert.ok(!activated.isError, text(activated));
  assert.equal(workflows[0].is_active, true);

  const deleted = await client.callTool({ name: "spur_delete_message_template", arguments: { template_id: smsId, confirm: true } });
  assert.ok(!deleted.isError, text(deleted));

  // -- Billing: options → top up via Stripe link → confirm payment → upgrade → switch (approval) → auto-recharge
  const options = await client.callTool({ name: "spur_show_billing_options", arguments: {} });
  assert.ok(!options.isError, text(options));
  const optionsData = options.structuredContent as any;
  assert.deepEqual(optionsData.top_up_presets_usd, [25, 50, 100]);
  assert.deepEqual(optionsData.plans.map((p: any) => [p.id, p.current]), [["solo", true], ["agent", false], ["team", false]]);
  assert.match(text(options), /plan_id: agent\)/);

  assert.equal((await client.callTool({ name: "spur_top_up_wallet", arguments: { amount_usd: 2 } })).isError, true, "top-ups below $5 are refused");
  const topUp = await client.callTool({ name: "spur_top_up_wallet", arguments: { amount_usd: 40.5 } });
  assert.ok(!topUp.isError, text(topUp));
  const topUpData = topUp.structuredContent as any;
  assert.equal(calls.filter(c => c.path === "/api/billing/checkout/wallet").at(-1)!.body.amount_cents, 4050);
  assert.match(topUpData.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
  assert.ok(text(topUp).includes(topUpData.checkout_url) && text(topUp).includes(topUpData.session_id), "the link and session id reach the assistant");

  const unpaid = await client.callTool({ name: "spur_check_payment", arguments: { session_id: topUpData.session_id } });
  assert.equal((unpaid.structuredContent as any).paid, false);
  assert.match(text(unpaid), /No payment yet/);
  checkoutSessions.get(topUpData.session_id)!.paid = true;
  const paid = await client.callTool({ name: "spur_check_payment", arguments: { session_id: topUpData.session_id } });
  assert.match(text(paid), /Payment received\. Wallet balance: \$90\.50/);
  assert.equal((paid.structuredContent as any).options.wallet_balance_usd, 90.5);
  await client.callTool({ name: "spur_check_payment", arguments: { session_id: topUpData.session_id } });
  assert.equal(walletUsd, 90.5, "checking again never credits twice");

  assert.equal((await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "platinum" } })).isError, true, "unknown plans are refused");
  const upgrade = await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "agent", billing_interval: "annual" } });
  assert.ok(!upgrade.isError, text(upgrade));
  assert.equal((upgrade.structuredContent as any).view, "checkout", "a first subscription goes through Stripe checkout without confirm");
  assert.deepEqual(calls.filter(c => c.path === "/api/billing/checkout/subscription").at(-1)!.body, { plan_id: "agent", billing_interval: "annual" });
  checkoutSessions.get((upgrade.structuredContent as any).session_id)!.paid = true;
  await client.callTool({ name: "spur_check_payment", arguments: { session_id: (upgrade.structuredContent as any).session_id } });
  assert.equal(billingAccount.planId, "agent");

  const same = await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "agent", billing_interval: "annual" } });
  assert.match(text(same), /already on the Agent plan/);
  const subPostsBefore = calls.filter(c => c.path === "/api/billing/checkout/subscription").length;
  const pending = await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "team" } });
  assert.equal((pending.structuredContent as any).view, "confirm_plan");
  assert.match(text(pending), /Agent → Team \(\$99\/mo\).*prorated/);
  assert.equal(calls.filter(c => c.path === "/api/billing/checkout/subscription").length, subPostsBefore, "switching a paid subscription waits for approval");
  const planSwitched = await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "team", confirm: true } });
  assert.match(text(planSwitched), /now on the Team plan \(monthly\)/);
  assert.equal(billingAccount.planId, "team");

  const downgrade = await client.callTool({ name: "spur_change_plan", arguments: { plan_id: "solo" } });
  assert.equal((downgrade.structuredContent as any).url, "https://billing.stripe.com/p/session/test_1", "moving to the free plan goes through the portal");
  const portal = await client.callTool({ name: "spur_manage_billing", arguments: {} });
  assert.match(text(portal), /billing\.stripe\.com/);

  const autoAsk = await client.callTool({ name: "spur_set_auto_recharge", arguments: { enabled: true, amount_usd: 50, threshold_usd: 10 } });
  assert.ok(!calls.some(c => c.path === "/api/billing/wallet/auto-recharge"), "auto-recharge waits for approval");
  assert.match(text(autoAsk), /confirm=true/);
  assert.equal((await client.callTool({ name: "spur_set_auto_recharge", arguments: { enabled: true, amount_usd: 10, threshold_usd: 10, confirm: true } })).isError, true);
  const autoOn = await client.callTool({ name: "spur_set_auto_recharge", arguments: { enabled: true, amount_usd: 50, threshold_usd: 10, confirm: true } });
  assert.ok(!autoOn.isError, text(autoOn));
  assert.deepEqual(calls.filter(c => c.path === "/api/billing/wallet/auto-recharge").at(-1)!.body, { enabled: true, amount_cents: 5000, threshold_cents: 1000 });
  await client.callTool({ name: "spur_set_auto_recharge", arguments: { enabled: false } });
  assert.equal(billingAccount.autoRechargeEnabled, false, "turning it off needs no approval");

  // -- ChatGPT search/fetch
  const found = await client.callTool({ name: "search", arguments: { query: "elm" } });
  const results = JSON.parse(text(found)).results;
  assert.equal(results[0].id, "property:prop-1");

  // -- Every Spur call carried the user's Spur token, never ours (public QR images are fetched anonymously)
  const publicPath = (path: string) => path.startsWith("/api/auth") || /^\/api\/direct-mail\/qr\/[^/]+\/image\.png$/.test(path);
  assert.ok(calls.filter(c => c.path.startsWith("/api/") && !publicPath(c.path)).every(c => c.auth?.startsWith("Bearer ey")));
  assert.ok(calls.filter(c => publicPath(c.path) && !c.path.startsWith("/api/auth")).every(c => !c.auth), "the user's token never goes to public image URLs");

  await client.close();

  // -- stdio mode: a stale access token is refreshed transparently and the call retried
  const stdio = new Client({ name: "smoke-stdio", version: "1.0.0" });
  await stdio.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), TRANSPORT: "stdio", SPUR_API_URL: spurUrl, SPUR_ACCESS_TOKEN: "stale-token", SPUR_REFRESH_TOKEN: "refresh-stdio" }
    })
  );
  const before = refreshCount;
  const listed = await stdio.callTool({ name: "spur_list_saved_properties", arguments: {} });
  assert.ok(!listed.isError, text(listed));
  assert.equal(refreshCount, before + 1, "stdio refreshed the stale token once");
  await stdio.close();

  // -- Vercel entry (api/index.js): the exported app accepts its public host and real browser Origins
  const vercelPort = 19_000 + Math.floor(Math.random() * 1000);
  const vercel = spawn(
    "node",
    ["--input-type=module", "-e", `const { default: app } = await import("./api/index.js"); app.listen(${vercelPort}, "127.0.0.1");`],
    {
      env: { ...process.env, VERCEL: "1", HOST: "", SPUR_API_URL: spurUrl, MCP_PUBLIC_URL: "https://mcp.spur.example", VERCEL_URL: "spur-mcp-abc123.vercel.app", MCP_TOKEN_SECRET: randomBytes(32).toString("hex"), MAP_TILE_CONTACT: "ops@example.com" },
      stdio: ["ignore", "inherit", "inherit"]
    }
  );
  try {
    const hit = (path: string, host: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: "127.0.0.1", port: vercelPort, path, method: init.method || "GET", headers: { Host: host, ...init.headers } }, res => {
          res.resume();
          resolve(res.statusCode || 0);
        });
        req.on("error", reject);
        req.end(init.body);
      });
    for (let i = 0; i < 50; i++) {
      if (await hit("/healthz", "mcp.spur.example").catch(() => 0)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(await hit("/healthz", "mcp.spur.example"), 200, "public host is accepted");
    assert.equal(await hit("/healthz", "spur-mcp-abc123.vercel.app"), 200, "the Vercel deployment URL is accepted");
    assert.equal(await hit("/healthz", "evil.example"), 403, "unknown Host headers are rejected");
    const form = await hit("/oauth/authorize", "mcp.spur.example", {
      method: "POST",
      headers: { Origin: "https://mcp.spur.example", "Content-Type": "application/x-www-form-urlencoded" },
      body: "req=bogus"
    });
    assert.equal(form, 400, "the sign-in form is not blocked by localhost-only Origin checks");
  } finally {
    vercel.kill();
  }

  console.error(`Smoke test passed (${names.length} tools).`);
}

main()
  .then(() => {
    child?.kill();
    process.exit(0);
  })
  .catch(error => {
    console.error(error);
    child?.kill();
    process.exit(1);
  });
