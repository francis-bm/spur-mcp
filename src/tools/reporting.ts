/**
 * Read-only reporting: billing/wallet, campaigns and direct-mail delivery.
 */
import * as z from "zod/v4";
import { bullets, date, READ_ONLY, structuredResult, textResult, uuid, type ToolContext } from "./shared.js";

interface Metric {
  label?: string;
  type?: string;
  used?: number;
  includedMonthly?: number | null;
  remaining?: number | null;
  unitPriceMicros?: number;
  totalSpendCents?: number;
}

interface BillingSummary {
  account?: { planId?: string; subscriptionStatus?: string; currentPeriodEnd?: string; autoRechargeEnabled?: boolean };
  wallet?: { balanceUsd?: number };
  usagePeriod?: { start?: string; end?: string };
  overview?: { totalSpendUsd?: number };
  plan?: { name?: string; label?: string };
  metrics?: Record<string, Metric>;
}

interface Campaign {
  id: string;
  name: string;
  campaign_type?: string;
  status?: string;
  total_recipients?: number;
  processed_recipients?: number;
  failed_recipients?: number;
  created_at?: string;
  started_at?: string | null;
}

/** Flattens simple key/value stats objects into readable bullets */
function statBullets(source: Record<string, unknown> | undefined, prefix = ""): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(source || {})) {
    const label = `${prefix}${key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")}`;
    if (typeof value === "number" || typeof value === "string") lines.push(`- ${label}: ${value}`);
    else if (value && typeof value === "object" && !Array.isArray(value) && prefix === "") lines.push(...statBullets(value as Record<string, unknown>, `${label} › `));
  }
  return lines;
}

export function registerReportingTools({ server, spur }: ToolContext) {
  server.registerTool(
    "spur_get_billing_summary",
    {
      title: "Billing summary",
      description: "Plan, wallet balance, and this period's usage and remaining allowance per feature (searches, enrichment, SMS, postcards, letters, AI). Check this before large sends.",
      annotations: READ_ONLY
    },
    async ctx => {
      const s = await spur.data<BillingSummary>("GET", "/billing/summary", { signal: ctx.mcpReq.signal });
      const metrics = Object.entries(s.metrics || {}).map(([key, m]) => {
        const allowance = m.includedMonthly === null ? "unlimited" : m.includedMonthly !== undefined ? `${m.remaining ?? "?"} of ${m.includedMonthly} left` : "";
        const price = m.unitPriceMicros ? `, then $${(m.unitPriceMicros / 1_000_000).toFixed(2)} each` : "";
        return `- ${m.label || key}: used ${m.used ?? 0}${allowance ? ` (${allowance}${price})` : price}`;
      });
      const text = [
        "# Spur billing",
        bullets([
          ["Plan", s.plan?.name || s.plan?.label || s.account?.planId],
          ["Subscription", s.account?.subscriptionStatus],
          ["Wallet balance", s.wallet?.balanceUsd !== undefined ? `$${s.wallet.balanceUsd.toFixed(2)}` : undefined],
          ["Auto-recharge", s.account?.autoRechargeEnabled ? "on" : "off"],
          ["Usage period", s.usagePeriod ? `${date(s.usagePeriod.start)} – ${date(s.usagePeriod.end)}` : undefined],
          ["Spend this period", s.overview?.totalSpendUsd !== undefined ? `$${s.overview.totalSpendUsd.toFixed(2)}` : undefined]
        ]),
        "",
        "## Usage",
        ...metrics,
        "",
        "To add funds or upgrade: spur_show_billing_options (buttons), spur_top_up_wallet or spur_change_plan."
      ].join("\n");
      return structuredResult(text, {
        wallet_balance_usd: s.wallet?.balanceUsd ?? null,
        metrics: Object.fromEntries(Object.entries(s.metrics || {}).map(([k, m]) => [k, { used: m.used ?? 0, remaining: m.remaining ?? null, unit_price_usd: m.unitPriceMicros ? m.unitPriceMicros / 1e6 : null }]))
      });
    }
  );

  server.registerTool(
    "spur_list_campaigns",
    {
      title: "List campaigns",
      description: "The user's campaigns (bulk email, SMS, direct mail, outreach) with status and recipient progress.",
      inputSchema: z.strictObject({
        status: z.enum(["draft", "active", "paused", "completed", "cancelled"]).optional().describe("Only campaigns with this status"),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum campaigns to return"),
        offset: z.number().int().min(0).default(0).describe("Campaigns to skip, for paging")
      }),
      annotations: READ_ONLY
    },
    async ({ status, limit, offset }, ctx) => {
      const body = await spur.request<{ data?: { campaigns?: Campaign[]; total?: number } | Campaign[] }>("GET", "/campaigns", {
        query: { status, limit, offset },
        signal: ctx.mcpReq.signal
      });
      const campaigns = Array.isArray(body.data) ? body.data : body.data?.campaigns || [];
      const total = Array.isArray(body.data) ? campaigns.length : (body.data?.total ?? campaigns.length);
      if (!campaigns.length) return textResult(status ? `No ${status} campaigns.` : "No campaigns yet.");
      const next = offset + campaigns.length;
      return textResult(
        [
          `# ${total} campaigns`,
          ...campaigns.map(
            c =>
              `- **${c.name}** (campaign_id: ${c.id}) — ${c.campaign_type?.replace(/_/g, " ")}, ${c.status}; ${c.processed_recipients ?? 0}/${c.total_recipients ?? 0} processed${c.failed_recipients ? `, ${c.failed_recipients} failed` : ""}; created ${date(c.created_at)}`
          ),
          total > next ? `\nMore results: call again with offset=${next}.` : ""
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "spur_get_campaign_stats",
    {
      title: "Campaign stats",
      description: "Delivery and run statistics for one campaign.",
      inputSchema: z.strictObject({ campaign_id: uuid("Campaign") }),
      annotations: READ_ONLY
    },
    async ({ campaign_id }, ctx) => {
      const stats = await spur.data<Record<string, unknown>>("GET", `/campaigns/${encodeURIComponent(campaign_id)}/stats`, { signal: ctx.mcpReq.signal });
      const lines = statBullets(stats);
      return textResult(`# Campaign ${campaign_id}\n${lines.length ? lines.join("\n") : "No stats yet."}`);
    }
  );

  server.registerTool(
    "spur_get_direct_mail_analytics",
    {
      title: "Direct mail analytics",
      description: "Letters and postcards sent, delivered, in transit and returned, plus USPS tracking totals and spend.",
      annotations: READ_ONLY
    },
    async ctx => {
      const analytics = await spur.data<{ stats?: Record<string, unknown> & { totalCost?: number }; mailpieceStats?: Record<string, unknown> }>(
        "GET",
        "/direct-mail/analytics",
        { signal: ctx.mcpReq.signal }
      );
      const { totalCost, ...stats } = analytics.stats || {};
      const lines = [
        "# Direct mail",
        ...statBullets(stats),
        totalCost !== undefined ? `- total cost: $${Number(totalCost).toFixed(2)}` : "",
        analytics.mailpieceStats ? "\n## USPS tracking" : "",
        ...statBullets(analytics.mailpieceStats)
      ].filter(Boolean);
      return textResult(lines.join("\n"));
    }
  );
}
