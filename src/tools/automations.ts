/**
 * Search automations: saved searches that run on a schedule and can auto-save / auto-enrich results.
 */
import * as z from "zod/v4";
import { describeFilters, EVENT_LABELS, EVENTS_GUIDE, sharedFilterShape, type PropertyEvent } from "./searchFilters.js";
import { bullets, dateTime, OUTWARD, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };

interface Automation {
  id: string;
  name: string;
  enabled?: boolean;
  run_time?: string;
  frequency?: string;
  day_of_week?: number;
  week_of_month?: number;
  timezone?: string;
  location?: string;
  min_amount?: number | null;
  max_amount?: number | null;
  auto_save?: boolean;
  auto_enrich?: boolean;
  status?: string | null;
  events?: string[] | null;
  next_run_at?: string | null;
  last_run_at?: string | null;
}

function schedule(a: Automation): string {
  const time = (a.run_time || "").slice(0, 5);
  const tz = a.timezone && a.timezone !== "UTC" ? ` ${a.timezone}` : " UTC";
  const day = DAYS[a.day_of_week ?? 1];
  switch (a.frequency) {
    case "daily":
      return `daily at ${time}${tz}`;
    case "weekdays":
      return `weekdays at ${time}${tz}`;
    case "weekly":
      return `every ${day} at ${time}${tz}`;
    case "biweekly":
      return `every other ${day} at ${time}${tz}`;
    case "monthly":
      return `the ${WEEKS[a.week_of_month ?? 1] || "first"} ${day} of each month at ${time}${tz}`;
    default:
      return `${a.frequency || "?"} at ${time}${tz}`;
  }
}

export function registerAutomationTools({ server, spur }: ToolContext) {
  server.registerTool(
    "spur_list_search_automations",
    {
      title: "List search automations",
      description: "Scheduled property searches with their schedule, filters, and next/last run times.",
      annotations: READ_ONLY
    },
    async ctx => {
      const automations = (await spur.data<Automation[]>("GET", "/automation/configs", { signal: ctx.mcpReq.signal })) || [];
      if (!automations.length) return textResult("No search automations yet. Create one with spur_create_search_automation.");
      return textResult(
        [
          `# ${automations.length} search automations`,
          ...automations.map(
            a =>
              `- **${a.name}** (automation_id: ${a.id}) — ${a.enabled ? "on" : "off"}, ${a.location}, ${schedule(a)}; next ${dateTime(a.next_run_at)}, last ${dateTime(a.last_run_at)}${a.status ? `, ${a.status}` : ""}${a.events?.length ? `, events: ${a.events.map(e => EVENT_LABELS[e as PropertyEvent] || e).join(", ")}` : ""}${a.auto_save ? ", auto-saves" : ""}${a.auto_enrich ? ", auto-enriches" : ""}`
          )
        ].join("\n")
      );
    }
  );

  server.registerTool(
    "spur_create_search_automation",
    {
      title: "Create search automation",
      description: `Schedule a recurring property search. Every run uses 1 search credit, or 2 when it makes more than 3 ZHomes calls (several event types, tax/sale-history events, furnished-only or description-based filters). New matches can be saved to a list and enriched automatically (auto_enrich spends skip-trace credits on every run, so confirm with the user).

Examples:
  - "every Monday 8am Central, Dallas rentals under $2k" -> frequency="weekly", day_of_week=1, run_time="08:00", timezone="America/Chicago", location="Dallas, TX", max_amount=2000
  - "last Friday of each month" -> frequency="monthly", day_of_week=5, week_of_month=-1
  - "every morning, new pre-foreclosures and price drops in Houston, save to my Distress list" -> frequency="daily", run_time="07:00", location="Houston, TX", events=["preforeclosure","price_drop"], list_id=…

Accepts the same advanced and event filters as spur_search_properties (min_amount / max_amount instead of min_price / max_price). Run the search once with spur_search_properties first so the user can check the results before scheduling.

In automations each event fires once, on the run that first sees it, so the same property isn't saved twice; change events start reporting from the second run. "delisted" is only available here.

${EVENTS_GUIDE}`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Automation name shown in Spur"),
        location: z.string().min(2).max(200).describe('City/state or ZIP, e.g. "Dallas, TX"'),
        frequency: z.enum(["daily", "weekdays", "weekly", "biweekly", "monthly"]).describe("How often the search runs"),
        run_time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
          .describe('24h local time "HH:MM"'),
        timezone: z.string().default("UTC").describe('IANA time zone, e.g. "America/Chicago"'),
        day_of_week: z.number().int().min(0).max(6).optional().describe("0=Sunday … 6=Saturday; for weekly, biweekly, monthly"),
        week_of_month: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]).optional().describe("Monthly only; -1 = last"),
        min_amount: z.number().min(0).optional().describe("Minimum price in USD (rent per month for forRent)"),
        max_amount: z.number().min(0).optional().describe("Maximum price in USD (rent per month for forRent)"),
        listing_status: z.enum(["forRent", "forSale", "sold"]).default("forRent").describe("Which listings to search"),
        ...sharedFilterShape,
        ai_query: z.string().max(1500).optional().describe("Qualitative intent; each run re-ranks listings by description against it"),
        list_id: z.string().optional().describe("Save new matches into this property list"),
        auto_save: z.boolean().default(true).describe("Save new matches to the user's properties"),
        auto_enrich: z.boolean().default(false).describe("Skip-trace new matches on every run (spends enrichment credits)"),
        enabled: z.boolean().default(true).describe("false = save it paused")
      }),
      annotations: WRITE
    },
    async (args, ctx) => {
      const { listing_status, ...rest } = args;
      const body = { ...rest, status: listing_status };
      const created = await spur.data<Automation>("POST", "/automation/configs", { body, signal: ctx.mcpReq.signal });
      const filters = describeFilters(rest, [
        "name", "location", "frequency", "run_time", "timezone", "day_of_week", "week_of_month", "list_id", "auto_save", "auto_enrich", "enabled"
      ]);
      return structuredResult(
        [
          `Created **${created.name}** (automation_id: ${created.id}).`,
          bullets([
            ["Runs", schedule(created)],
            ["Location", created.location],
            ["Status", created.status || listing_status],
            ["Filters", filters || undefined],
            ["Next run", dateTime(created.next_run_at)],
            ["Enabled", created.enabled ? "yes" : "no"]
          ])
        ].join("\n"),
        { automation_id: created.id, next_run_at: created.next_run_at ?? null }
      );
    }
  );

  server.registerTool(
    "spur_run_search_automation",
    {
      title: "Run search automation now",
      description: "Run a search automation immediately instead of waiting for its schedule. Uses 1 search credit (2 if the run makes more than 3 ZHomes calls), and enrichment credits if auto_enrich is on.",
      inputSchema: z.strictObject({ automation_id: uuid("Automation") }),
      annotations: OUTWARD
    },
    async ({ automation_id }, ctx) => {
      const result = await spur.data<Record<string, unknown>>("POST", `/automation/configs/${encodeURIComponent(automation_id)}/trigger`, {
        signal: ctx.mcpReq.signal
      });
      const summary = Object.entries(result || {})
        .filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean")
        .map(([k, v]) => [k.replace(/_/g, " "), v] as [string, unknown]);
      return textResult(`Ran automation ${automation_id}.\n${bullets(summary)}`);
    }
  );

  server.registerTool(
    "spur_get_automation_logs",
    {
      title: "Automation run history",
      description: "Recent runs of a search automation: when, how many found/saved/enriched, and errors.",
      inputSchema: z.strictObject({ automation_id: uuid("Automation"), limit: z.number().int().min(1).max(50).default(10).describe("Maximum runs to return") }),
      annotations: READ_ONLY
    },
    async ({ automation_id, limit }, ctx) => {
      const logs = (await spur.data<Array<Record<string, unknown>>>("GET", `/automation/configs/${encodeURIComponent(automation_id)}/logs`, { signal: ctx.mcpReq.signal })) || [];
      if (!logs.length) return textResult("This automation hasn't run yet.");
      return textResult(
        [
          `# Last ${Math.min(limit, logs.length)} runs`,
          ...logs.slice(0, limit).map(l => {
            const when = dateTime(l.started_at || l.created_at || l.run_at);
            const counts = ["properties_found", "properties_saved", "properties_enriched", "found", "saved", "enriched"]
              .filter(k => l[k] !== undefined && l[k] !== null)
              .map(k => `${k.replace(/^properties_/, "")} ${l[k]}`)
              .join(", ");
            const ev = (l.execution_details as { eventStats?: { perEvent?: Record<string, number> } } | null)?.eventStats;
            const hits = Object.entries(ev?.perEvent || {})
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${EVENT_LABELS[k as PropertyEvent] || k} ${n}`)
              .join(", ");
            return `- ${when} — ${l.status || "done"}${counts ? `: ${counts}` : ""}${hits ? ` — events: ${hits}` : ""}${l.error_message ? ` — error: ${l.error_message}` : ""}`;
          })
        ].join("\n")
      );
    }
  );
}
