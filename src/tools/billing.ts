/**
 * Paying for Spur from the chat: wallet top-ups, plan upgrades, auto-recharge and the Stripe portal.
 *
 * Top-ups and new subscriptions return a Stripe Checkout link; the user enters card details on
 * Stripe, never in the chat. The one path that charges a saved card directly (switching an active
 * subscription) and turning on auto-recharge both need `confirm: true`.
 */
import * as z from "zod/v4";
import { BILLING_URI, widgetMeta } from "../widgets.js";
import { bullets, date, READ_ONLY, structuredResult, type ToolContext } from "./shared.js";

type Interval = "monthly" | "annual";

interface CatalogPlan {
  id: string;
  name: string;
  tier: number;
  pricing?: { monthlyCents?: number; annualCents?: number; annualMonthlyEquivalentCents?: number };
  highlights?: string[];
}

interface Summary {
  account?: {
    planId?: string;
    billingInterval?: Interval | null;
    subscriptionStatus?: string | null;
    stripeSubscriptionId?: string | null;
    stripeCustomerId?: string | null;
    defaultPaymentMethodId?: string | null;
    currentPeriodEnd?: string | null;
    cancelAtPeriodEnd?: boolean;
    autoRechargeEnabled?: boolean;
    autoRechargeAmountCents?: number | null;
    autoRechargeThresholdCents?: number | null;
  };
  wallet?: { balanceUsd?: number; topUpPresetAmountsCents?: number[]; minTopUpAmountCents?: number };
  catalog?: CatalogPlan[];
  stripeEnabled?: boolean;
}

interface CheckoutResult {
  mode: "checkout" | "subscription_updated";
  checkoutUrl?: string;
  sessionId?: string;
  subscriptionId?: string;
}

/** Creates a Stripe link but moves no money; the user pays (or not) on Stripe's page */
const CHECKOUT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
/** Can charge the user's saved card without another Stripe step */
const CHARGES_CARD = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/** Mirrors billingService.isSubscriptionActive: these statuses switch plans in place instead of checking out */
const ACTIVE_STATUSES = ["active", "trialing", "past_due"];

const cents = (value: number | null | undefined) => (value === null || value === undefined ? undefined : `$${(value / 100).toFixed(2).replace(/\.00$/, "")}`);
const toCents = (usd: number) => Math.round(usd * 100);

const meta = (invoking: string, invoked: string) => widgetMeta(BILLING_URI, invoking, invoked);

function hasActiveSubscription(s: Summary) {
  return Boolean(s.account?.stripeSubscriptionId && ACTIVE_STATUSES.includes(s.account?.subscriptionStatus || ""));
}

function planPrice(plan: CatalogPlan, interval: Interval) {
  return interval === "annual"
    ? `${cents(plan.pricing?.annualCents)}/yr (${cents(plan.pricing?.annualMonthlyEquivalentCents)}/mo)`
    : `${cents(plan.pricing?.monthlyCents)}/mo`;
}

function stripeOff(s: Summary) {
  return s.stripeEnabled === false ? "Online payments are not set up for this Spur workspace yet. Ask the Spur admin to enable Stripe." : null;
}

/** Shape the billing widget reads for its main view */
function optionsPayload(s: Summary) {
  const current = s.account?.planId || "solo";
  return {
    view: "options",
    wallet_balance_usd: s.wallet?.balanceUsd ?? null,
    min_top_up_usd: (s.wallet?.minTopUpAmountCents ?? 500) / 100,
    top_up_presets_usd: (s.wallet?.topUpPresetAmountsCents || [2500, 5000, 10000]).map(c => c / 100),
    auto_recharge: {
      enabled: Boolean(s.account?.autoRechargeEnabled),
      amount_usd: s.account?.autoRechargeAmountCents ? s.account.autoRechargeAmountCents / 100 : null,
      threshold_usd: s.account?.autoRechargeThresholdCents !== null && s.account?.autoRechargeThresholdCents !== undefined ? s.account.autoRechargeThresholdCents / 100 : null,
      card_on_file: Boolean(s.account?.defaultPaymentMethodId)
    },
    current_plan: {
      id: current,
      interval: s.account?.billingInterval || null,
      status: s.account?.subscriptionStatus || null,
      renews_on: s.account?.currentPeriodEnd || null,
      cancel_at_period_end: Boolean(s.account?.cancelAtPeriodEnd)
    },
    has_active_subscription: hasActiveSubscription(s),
    has_billing_portal: Boolean(s.account?.stripeCustomerId),
    stripe_enabled: s.stripeEnabled !== false,
    plans: (s.catalog || []).map(p => ({
      id: p.id,
      name: p.name,
      tier: p.tier,
      monthly_usd: (p.pricing?.monthlyCents ?? 0) / 100,
      annual_usd: (p.pricing?.annualCents ?? 0) / 100,
      annual_monthly_usd: (p.pricing?.annualMonthlyEquivalentCents ?? 0) / 100,
      highlights: p.highlights || [],
      current: p.id === current
    }))
  };
}

function checkoutText(what: string, url: string, sessionId: string) {
  return [
    `Stripe checkout is ready for ${what}.`,
    "",
    `**[Pay securely with Stripe](${url})**`,
    "",
    `Give the user this link (or they can use the Pay button in the widget). Card details are entered on Stripe, never in the chat. When they say they've paid, call spur_check_payment with session_id "${sessionId}" to confirm and show the new balance. The link expires in 24 hours.`
  ].join("\n");
}

export function registerBillingTools({ server, spur }: ToolContext) {
  const summary = (signal: AbortSignal) => spur.data<Summary>("GET", "/billing/summary", { signal });

  server.registerTool(
    "spur_show_billing_options",
    {
      title: "Top up or upgrade",
      description:
        "Shows the user's wallet balance, one-click top-up amounts, auto-recharge status and every Spur plan with prices, in a widget with Pay/Upgrade buttons. Use whenever the user wants to add funds, buy credits, upgrade, change or compare plans, or a send failed for billing reasons.",
      annotations: READ_ONLY,
      _meta: meta("Loading billing options…", "Billing options ready")
    },
    async ctx => {
      const s = await summary(ctx.mcpReq.signal);
      const payload = optionsPayload(s);
      const current = payload.plans.find(p => p.current);
      const text = [
        "# Top up or upgrade",
        bullets([
          ["Wallet balance", payload.wallet_balance_usd !== null ? `$${payload.wallet_balance_usd.toFixed(2)}` : undefined],
          ["Top-up amounts", `${payload.top_up_presets_usd.map(v => `$${v}`).join(", ")} or any amount from $${payload.min_top_up_usd}`],
          [
            "Auto-recharge",
            payload.auto_recharge.enabled ? `on: adds $${payload.auto_recharge.amount_usd} when the balance drops below $${payload.auto_recharge.threshold_usd}` : "off"
          ],
          [
            "Current plan",
            current
              ? `${current.name}${payload.current_plan.interval ? ` (${payload.current_plan.interval})` : ""}${payload.current_plan.renews_on ? `, renews ${date(payload.current_plan.renews_on)}` : ""}${payload.current_plan.cancel_at_period_end ? ", cancels at period end" : ""}`
              : payload.current_plan.id
          ]
        ]),
        "",
        "## Plans",
        ...(s.catalog || []).map(
          p =>
            `- **${p.name}** (plan_id: ${p.id})${p.id === payload.current_plan.id ? " ← current" : ""}: ${p.pricing?.monthlyCents ? `${planPrice(p, "monthly")} or ${planPrice(p, "annual")}` : "free"}${p.highlights?.length ? `. ${p.highlights.join("; ")}` : ""}`
        ),
        "",
        stripeOff(s) ||
          "The widget has Pay and Upgrade buttons. Or call spur_top_up_wallet (amount_usd) / spur_change_plan (plan_id, billing_interval) to get a Stripe link."
      ].join("\n");
      return structuredResult(text, payload);
    }
  );

  server.registerTool(
    "spur_top_up_wallet",
    {
      title: "Top up wallet",
      description:
        "Creates a Stripe checkout link to add funds to the user's Spur wallet (pays for postcards, letters, SMS, enrichment and other usage beyond the plan). No money moves until the user pays on Stripe, so no confirmation is needed. If the user didn't name an amount, suggest $25, $50 or $100, or enough to cover the send they're planning.",
      inputSchema: z.strictObject({
        amount_usd: z.number().min(5).max(10_000).describe("Amount to add in US dollars (minimum $5)")
      }),
      annotations: CHECKOUT,
      _meta: meta("Creating Stripe checkout…", "Checkout ready")
    },
    async ({ amount_usd }, ctx) => {
      const amountCents = toCents(amount_usd);
      const result = await spur.data<CheckoutResult>("POST", "/billing/checkout/wallet", { body: { amount_cents: amountCents }, signal: ctx.mcpReq.signal });
      const label = `a ${cents(amountCents)} wallet top-up`;
      return structuredResult(checkoutText(label, result.checkoutUrl as string, result.sessionId as string), {
        view: "checkout",
        purpose: "top_up",
        label: `Add ${cents(amountCents)} to your wallet`,
        amount_usd: amountCents / 100,
        checkout_url: result.checkoutUrl,
        session_id: result.sessionId
      });
    }
  );

  server.registerTool(
    "spur_change_plan",
    {
      title: "Upgrade or change plan",
      description: `Moves the user to another Spur plan (ids from spur_show_billing_options; usually agent, team or brokerage).
- No paid subscription yet: returns a Stripe checkout link. No confirmation needed.
- Already subscribed: switches the plan immediately and charges or credits the prorated difference to the saved card. Call once without confirm to get the exact change, ask the user to approve it, then call again with confirm=true.
- Moving to the free Solo plan returns a billing-portal link where the user cancels the paid subscription.`,
      inputSchema: z.strictObject({
        plan_id: z.string().min(1).max(40).describe("Target plan id, e.g. agent, team, brokerage"),
        billing_interval: z.enum(["monthly", "annual"]).default("monthly").describe("annual is cheaper per month"),
        confirm: z
          .boolean()
          .optional()
          .describe("Only for users who already have a paid subscription: true ONLY after they approved the switch and the prorated charge in the conversation.")
      }),
      annotations: CHARGES_CARD,
      _meta: meta("Preparing plan change…", "Plan change ready")
    },
    async ({ plan_id, billing_interval, confirm }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const s = await summary(signal);
      const off = stripeOff(s);
      if (off) return structuredResult(off, { view: "notice", message: off });

      const plans = s.catalog || [];
      const target = plans.find(p => p.id === plan_id.trim().toLowerCase());
      if (!target) throw new Error(`Unknown plan "${plan_id}". Valid plan_id values: ${plans.map(p => p.id).join(", ")}.`);
      const current = plans.find(p => p.id === (s.account?.planId || "solo"));
      const active = hasActiveSubscription(s);

      if (target.id === current?.id && (!active || s.account?.billingInterval === billing_interval)) {
        const message = `The user is already on the ${target.name} plan${active ? ` (${billing_interval})` : ""}. Nothing to change.`;
        return structuredResult(message, { view: "notice", message });
      }

      // Free plan: no checkout exists; downgrading means cancelling the paid subscription in Stripe's portal
      if (!target.pricing?.monthlyCents) {
        if (!s.account?.stripeCustomerId) {
          const message = `The user is already on the free ${target.name} plan.`;
          return structuredResult(message, { view: "notice", message });
        }
        const portal = await spur.data<{ url: string }>("POST", "/billing/portal", { body: {}, signal });
        const message = `To move to ${target.name}, cancel the paid subscription in the Stripe billing portal. The current plan stays active until ${date(s.account?.currentPeriodEnd)}.`;
        return structuredResult(`${message}\n\n**[Open billing portal](${portal.url})**`, { view: "link", message, label: "Open billing portal", url: portal.url });
      }

      const change = `${current?.name || s.account?.planId} → ${target.name} (${planPrice(target, billing_interval)})`;
      if (active && confirm !== true) {
        const message = `Switching ${change} happens immediately, and the prorated difference is charged (or credited) to the saved card. Ask the user to approve, then call spur_change_plan again with confirm=true.`;
        return structuredResult(message, {
          view: "confirm_plan",
          message,
          plan_id: target.id,
          plan_name: target.name,
          billing_interval,
          price: planPrice(target, billing_interval)
        });
      }

      const result = await spur.data<CheckoutResult>("POST", "/billing/checkout/subscription", { body: { plan_id: target.id, billing_interval }, signal });
      if (result.mode === "subscription_updated") {
        const message = `Done: the user is now on the ${target.name} plan (${billing_interval}). The prorated difference goes on their next invoice or saved card, and the new limits apply right away.`;
        return structuredResult(message, { view: "notice", message, tone: "good" });
      }
      return structuredResult(checkoutText(`the ${target.name} plan (${planPrice(target, billing_interval)})`, result.checkoutUrl as string, result.sessionId as string), {
        view: "checkout",
        purpose: "subscription",
        label: `Subscribe to ${target.name}: ${planPrice(target, billing_interval)}`,
        plan_id: target.id,
        billing_interval,
        checkout_url: result.checkoutUrl,
        session_id: result.sessionId
      });
    }
  );

  server.registerTool(
    "spur_check_payment",
    {
      title: "Check payment",
      description:
        "After the user pays a Stripe checkout link from spur_top_up_wallet or spur_change_plan, confirms the payment went through and returns the new wallet balance and plan. Safe to call repeatedly.",
      inputSchema: z.strictObject({
        session_id: z.string().min(1).max(255).describe("session_id returned with the checkout link (starts with cs_)")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: meta("Checking payment…", "Payment checked")
    },
    async ({ session_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      // Spur credits a paid top-up here too, in case Stripe's webhook hasn't arrived yet
      const status = await spur.data<{ status?: string; paymentStatus?: string }>("GET", `/billing/checkout/${encodeURIComponent(session_id)}`, { signal });
      const s = await summary(signal);
      const paid = status.paymentStatus === "paid" || status.paymentStatus === "no_payment_required";
      const plan = (s.catalog || []).find(p => p.id === s.account?.planId);
      const balance = s.wallet?.balanceUsd !== undefined ? `$${s.wallet.balanceUsd.toFixed(2)}` : "unknown";
      const message = paid
        ? `Payment received. Wallet balance: ${balance}. Plan: ${plan?.name || s.account?.planId}.`
        : status.status === "expired"
          ? "That checkout link expired without a payment. Create a new one with spur_top_up_wallet or spur_change_plan."
          : status.paymentStatus === "unpaid" && status.status === "complete"
            ? "Stripe is still processing this payment (bank payments can take a few days). The funds appear automatically once it clears."
            : "No payment yet. The checkout is still open; the user can finish paying with the same link.";
      return structuredResult(message, {
        view: "payment_status",
        paid,
        message,
        session_id,
        options: optionsPayload(s)
      });
    }
  );

  server.registerTool(
    "spur_manage_billing",
    {
      title: "Billing portal",
      description: "Link to the user's Stripe billing portal: update the card on file, download invoices, change or cancel the subscription.",
      annotations: CHECKOUT,
      _meta: meta("Opening billing portal…", "Billing portal ready")
    },
    async ctx => {
      const portal = await spur.data<{ url: string }>("POST", "/billing/portal", { body: {}, signal: ctx.mcpReq.signal });
      const message = "The billing portal manages the card on file, invoices and the subscription.";
      return structuredResult(`${message}\n\n**[Open billing portal](${portal.url})**`, { view: "link", message, label: "Open billing portal", url: portal.url });
    }
  );

  server.registerTool(
    "spur_set_auto_recharge",
    {
      title: "Auto-recharge",
      description:
        "Turns wallet auto-recharge on or off. When on, Spur charges the saved card amount_usd whenever the balance drops below threshold_usd, so sends never fail for lack of funds. Needs a saved card (the first spur_top_up_wallet payment saves one). Turning it on needs the user's approval of the amount and threshold (confirm=true); turning it off doesn't.",
      inputSchema: z.strictObject({
        enabled: z.boolean().describe("true = turn auto-recharge on, false = off"),
        amount_usd: z.number().min(5).max(10_000).optional().describe("Amount added per recharge (required when enabling, minimum $5)"),
        threshold_usd: z.number().min(0).max(10_000).optional().describe("Recharge when the balance drops below this (required when enabling; lower than amount_usd)"),
        confirm: z.boolean().optional().describe("Required to enable: true ONLY after the user approved automatic charges of this amount at this threshold.")
      }),
      annotations: CHARGES_CARD
    },
    async ({ enabled, amount_usd, threshold_usd, confirm }, ctx) => {
      const signal = ctx.mcpReq.signal;
      if (enabled) {
        if (amount_usd === undefined || threshold_usd === undefined) throw new Error("amount_usd and threshold_usd are both required to turn auto-recharge on.");
        if (threshold_usd >= amount_usd) throw new Error("threshold_usd must be lower than amount_usd.");
        if (confirm !== true) {
          return structuredResult(
            `This will charge the saved card $${amount_usd} automatically whenever the wallet drops below $${threshold_usd}. Ask the user to approve, then call again with confirm=true.`,
            { view: "notice", message: `Auto-recharge needs approval: $${amount_usd} when below $${threshold_usd}.` }
          );
        }
        const s = await summary(signal);
        if (!s.account?.defaultPaymentMethodId) {
          throw new Error("No saved card yet. Top up once with spur_top_up_wallet (Stripe saves the card), then turn on auto-recharge.");
        }
      }
      await spur.data("POST", "/billing/wallet/auto-recharge", {
        body: enabled ? { enabled, amount_cents: toCents(amount_usd as number), threshold_cents: toCents(threshold_usd as number) } : { enabled: false },
        signal
      });
      const message = enabled
        ? `Auto-recharge is on: Spur adds $${amount_usd} whenever the wallet drops below $${threshold_usd}.`
        : "Auto-recharge is off. Sends fail when the wallet runs out, until the user tops up.";
      return structuredResult(message, { view: "notice", message, tone: "good" });
    }
  );
}
