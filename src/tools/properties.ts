/**
 * Property discovery: live search, details, saving, and the user's saved portfolio.
 * Search, details and saved-property listings render in the property explorer widget.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import { PROPERTY_EXPLORER_URI, widgetMeta } from "../widgets.js";
import { cardFromListing, cardFromSaved, cardMarkdown, type PropertyCard, type SavedProperty, type ZillowListing } from "./propertyCards.js";
import {
  AUTOMATION_ONLY_EVENTS, describeFilters, EVENT_LABELS, EVENTS_GUIDE, fromParsedFilters, searchOnlyFilterShape, sharedFilterShape, toSearchBody,
  type PropertyEvent
} from "./searchFilters.js";
import { bullets, money, paginate, paginationFields, READ_ONLY, structuredResult, textResult, WRITE, type ToolContext } from "./shared.js";

interface EventStats {
  events?: string[];
  skippedEvents?: string[];
  calls?: number;
  pulled?: number;
  matched?: number;
  perEvent?: Record<string, number>;
  baselineRows?: number;
  historyFetched?: number;
  truncated?: string[];
}

interface SearchResponse {
  data?: ZillowListing[];
  count?: number;
  meta?: {
    totalRecords?: number;
    aiUsed?: boolean;
    filterStats?: Record<string, number>;
    eventStats?: EventStats | null;
  };
}

const listingSchema = z
  .object({
    zpid: z.union([z.number(), z.string()]),
    address: z.object({
      streetAddress: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zipcode: z.string().optional()
    })
  })
  .passthrough()
  .describe("A listing object exactly as returned in spur_search_properties structuredContent.cards[].listing");

/** What the explorer widget receives; `mode` tells it which actions to show */
function explorerPayload(cards: PropertyCard[], extra: Record<string, unknown>) {
  return { view: "property-explorer", cards, ...extra };
}


// Argument names spur_search_properties accepts (for mapping parsed filters back).
const SEARCH_ARG_NAMES = [
  "location", "listing_status", "min_price", "max_price",
  ...Object.keys(sharedFilterShape), ...Object.keys(searchOnlyFilterShape)
];

/** Lines explaining event matching and why results were filtered out. */
function searchNotes(meta: SearchResponse["meta"], automationOnly: string[]): string[] {
  const notes: string[] = [];
  const ev = meta?.eventStats;
  if (ev?.events?.length) {
    const hits = Object.entries(ev.perEvent || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${EVENT_LABELS[k as PropertyEvent] || k} ${n}`);
    notes.push(`Events: ${hits.length ? hits.join(", ") : "no matches"} (from ${ev.pulled ?? 0} listings across ${ev.calls ?? 0} event searches).`);
    if (!ev.baselineRows) {
      notes.push("First look at this area: change events (price increase, back on market, etc.) start reporting from the next search; direct events (price drop, pending, distress stages, FSBO, new listing) already work.");
    }
    if (ev.truncated?.length) notes.push("Some event searches hit the result cap; narrow the location or price to see everything.");
    if (ev.historyFetched) notes.push(`Tax/sale history checked for the first ${ev.historyFetched} listings.`);
  }
  const skipped = [...new Set([...(ev?.skippedEvents || []), ...automationOnly])];
  if (skipped.length) notes.push(`${skipped.join(", ")} only runs in search automations (spur_create_search_automation).`);
  const removed = Object.entries(meta?.filterStats || {})
    .filter(([k, n]) => !["input", "output"].includes(k) && typeof n === "number" && n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} −${n}`);
  if (removed.length) notes.push(`Post-filters removed: ${removed.join(", ")}.`);
  return notes;
}

export function registerPropertyTools({ server, spur }: ToolContext) {
  registerAppTool(
    server,
    "spur_search_properties",
    {
      title: "Search properties",
      description: `Search live listings (Zillow data) in Spur with plain English and/or structured filters, including event filters. Results show as cards and a map.

Uses 1 property-search credit per call from the user's Spur plan, or 2 credits when the search makes more than 3 ZHomes calls (e.g. several event types, tax/sale-history events, or description-based filters). To check how a sentence will be interpreted before spending a credit, call spur_parse_search_query first.

Examples:
  - "3 bed houses under $2,500/mo in Austin owned 10+ years" -> location="Austin, TX", listing_status="forRent", home_type="singleFamily", min_beds=3, max_price=2500, min_ownership_years=10
  - "duplexes for sale in 78704 built before 1980 with absentee owners" -> location="78704", listing_status="forSale", home_type="multiFamily", max_year_built=1979, only_absentee=true
  - "new pre-foreclosures or price drops of 10%+ in Dallas this week" -> location="Dallas, TX", events=["preforeclosure","price_drop"], event_within_days=7, event_min_change_pct=10
  - "motivated sellers in Houston: stale, back on market, or fired their agent" -> location="Houston, TX", events=["stale_listing","back_on_market","agent_to_fsbo"]

${EVENTS_GUIDE}

Structured filters always win over what Spur infers from \`query\`; use query for qualitative intent (condition, style, "brick", "needs work") that only listing descriptions can match. Unset filters are left to the query.

Follow up with spur_save_properties to save listings the user likes (pass the cards' listing objects), or spur_create_search_automation to run the same filters on a schedule.`,
      inputSchema: z.strictObject({
        query: z.string().max(1500).optional().describe("Free-text intent; Spur's AI turns it into filters and re-ranks by description"),
        location: z.string().max(200).optional().describe('City and state ("Dallas, TX") or ZIP code'),
        listing_status: z.enum(["forRent", "forSale", "sold"]).optional().describe("Defaults to forRent when omitted and the query doesn't imply one"),
        min_price: z.number().min(0).optional().describe("Minimum price (monthly rent for rentals), USD"),
        max_price: z.number().min(0).optional().describe("Maximum price (monthly rent for rentals), USD"),
        ...sharedFilterShape,
        ...searchOnlyFilterShape,
        limit: z.number().int().min(1).max(50).default(20).describe("Maximum results to show")
      }),
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
      _meta: widgetMeta(PROPERTY_EXPLORER_URI, "Searching properties…", "Properties found")
    },
    async (args, ctx) => {
      if (!args.query && !args.location) {
        return { ...textResult("Give a location (city/state or ZIP) or a query that names one, e.g. location=\"Austin, TX\"."), isError: true };
      }
      const automationOnly = (args.events || []).filter(e => AUTOMATION_ONLY_EVENTS.includes(e));
      const body = { ...toSearchBody(args, ["limit"]), resultsPerPage: 50 };
      const result = await spur.request<SearchResponse>("POST", "/zillow/search", { body, signal: ctx.mcpReq.signal });
      const listings = result.data || [];
      const cards = listings.slice(0, args.limit).map(cardFromListing);
      const where = args.location || "your query";
      const applied = describeFilters(args, ["limit", "query", "location"]);
      const notes = searchNotes(result.meta, automationOnly);

      if (cards.length === 0) {
        return structuredResult(
          [
            `No listings matched in ${where}.`,
            applied ? `Filters: ${applied}.` : "",
            ...notes,
            "",
            "Next: widen the price or size range, drop the narrowest filter (the filter stats above show which removed the most), try a nearby city, or remove change events until a baseline exists."
          ].filter(Boolean).join("\n"),
          explorerPayload([], { title: `No results in ${where}`, mode: "search", eventStats: result.meta?.eventStats ?? null })
        );
      }
      const prices = cards.map(c => c.price).filter((p): p is number => !!p).sort((a, b) => a - b);
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : undefined;
      const text = [
        `# ${cards.length} of ${listings.length} listings in ${where}`,
        median ? `Median price ${money(median)}.${result.meta?.aiUsed ? " Ranked by AI against the query." : ""}` : "",
        applied ? `Filters: ${applied}.` : "",
        ...notes,
        "",
        cards.map((card, i) => cardMarkdown(card, i)).join("\n"),
        "",
        "The user sees these as cards and a map. To save some, call spur_save_properties with their listing objects."
      ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
      return structuredResult(
        text,
        explorerPayload(cards, { title: `${listings.length} listings in ${where}`, mode: "search", eventStats: result.meta?.eventStats ?? null })
      );
    }
  );

  server.registerTool(
    "spur_parse_search_query",
    {
      title: "Preview search filters",
      description: `Show how Spur interprets a plain-English property search (filters and events) without running it. Free: uses no search credit.

Use it to confirm intent before spending a credit, or to turn a vague request into explicit filters you can adjust. The returned arguments can be passed straight to spur_search_properties (keep the same location / status unless the user says otherwise). Exclusions ("no condos", "not foreclosures") are honoured by leaving those filters out.`,
      inputSchema: z.strictObject({
        query: z.string().min(1).max(1500).describe("The user's search in their own words")
      }),
      annotations: READ_ONLY
    },
    async ({ query }, ctx) => {
      const res = await spur.request<{ data?: Record<string, unknown>; source?: string }>("POST", "/zillow/parse-query", {
        body: { query },
        signal: ctx.mcpReq.signal
      });
      const parsed = res.data || {};
      const { args, ignored } = fromParsedFilters(parsed, SEARCH_ARG_NAMES);
      const intent = typeof parsed.semanticIntent === "string" ? parsed.semanticIntent : undefined;
      const events = Array.isArray(args.events) ? (args.events as PropertyEvent[]) : [];
      const lines = [
        `# Interpreted search${res.source === "heuristic" ? " (rule-based; AI parsing unavailable)" : ""}`,
        Object.keys(args).length ? bullets(Object.entries(args).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])) : "No structured filters found.",
        events.length ? `Events: ${events.map(e => EVENT_LABELS[e] || e).join(", ")}.` : "",
        intent ? `Qualitative intent (pass as query to re-rank by description): ${intent}` : "",
        ignored.length ? `Not usable as tool arguments: ${ignored.join(", ")}.` : "",
        "",
        "Pass these arguments to spur_search_properties (add query for the qualitative part)."
      ];
      return structuredResult(lines.filter(Boolean).join("\n"), { arguments: { ...args, ...(intent ? { query: intent } : {}) }, source: res.source ?? null });
    }
  );

  registerAppTool(
    server,
    "spur_get_property",
    {
      title: "Get property",
      description: `Show one property as a detailed card: a saved Spur property by property_id, or a live listing by zpid. Includes owner links and enrichment status for saved properties.`,
      inputSchema: z.strictObject({
        property_id: z.string().optional().describe("Saved Spur property id"),
        zpid: z.union([z.string(), z.number()]).optional().describe("Zillow property id from search results")
      }),
      annotations: { ...READ_ONLY, openWorldHint: true },
      _meta: widgetMeta(PROPERTY_EXPLORER_URI, "Loading property…", "Property loaded")
    },
    async ({ property_id, zpid }, ctx) => {
      if (property_id) {
        const property = await spur.data<SavedProperty & { owners?: Array<{ id: string; full_name?: string }> }>(
          "GET",
          `/properties/${encodeURIComponent(property_id)}`,
          { signal: ctx.mcpReq.signal }
        );
        const card = cardFromSaved(property);
        const owners = Array.isArray(property.owners) ? property.owners : [];
        const text = [
          cardMarkdown(card),
          owners.length ? `\nOwners: ${owners.map(o => `${o.full_name || "Unknown"} (owner_id: ${o.id})`).join(", ")}` : "",
          property.description ? `\nDescription: ${String(property.description).slice(0, 800)}` : ""
        ].join("");
        return structuredResult(text, explorerPayload([card], { title: card.address, mode: "detail" }));
      }
      if (zpid !== undefined) {
        const details = await spur.data<Record<string, unknown>>("GET", `/zillow/property-details/${encodeURIComponent(String(zpid))}`, {
          signal: ctx.mcpReq.signal
        });
        const addr = (details.address || {}) as Record<string, string>;
        const listing: ZillowListing = {
          zpid,
          address: {
            streetAddress: addr.streetAddress || (details.streetAddress as string),
            city: addr.city || (details.city as string),
            state: addr.state || (details.state as string),
            zipcode: addr.zipcode || (details.zipcode as string)
          },
          location: { latitude: details.latitude as number, longitude: details.longitude as number },
          price: (details.price as number) || undefined,
          bedrooms: details.bedrooms as number,
          bathrooms: details.bathrooms as number,
          livingArea: details.livingArea as number,
          yearBuilt: details.yearBuilt as number,
          propertyType: (details.homeType || details.propertyType) as string,
          photoUrl: (Array.isArray(details.photoUrls) ? details.photoUrls[0] : details.photoUrl) as string,
          zestimate: details.zestimate as number,
          rentZestimate: details.rentZestimate as number,
          detailUrl: `https://www.zillow.com/homedetails/${zpid}_zpid/`,
          rentalListingOwnerContact: details.rentalListingOwnerContact as ZillowListing["rentalListingOwnerContact"]
        };
        const card = cardFromListing(listing);
        const description = typeof details.description === "string" ? `\nDescription: ${details.description.slice(0, 800)}` : "";
        return structuredResult(cardMarkdown(card) + description, explorerPayload([card], { title: card.address, mode: "detail" }));
      }
      return { ...textResult("Pass property_id (saved property) or zpid (live listing)."), isError: true };
    }
  );

  registerAppTool(
    server,
    "spur_save_properties",
    {
      title: "Save properties",
      description: `Save live listings into the user's Spur properties (and optionally a property list). Pass listing objects from spur_search_properties structuredContent.cards[].listing. Already-saved listings are refreshed, not duplicated.`,
      inputSchema: z.strictObject({
        listings: z.array(listingSchema).min(1).max(50).describe("Listing objects copied unchanged from spur_search_properties structuredContent.cards[].listing"),
        list_id: z.string().optional().describe("Also add the saved properties to this property list (spur_list_property_lists)")
      }),
      annotations: WRITE,
      _meta: { ui: { resourceUri: PROPERTY_EXPLORER_URI, visibility: ["model", "app"] } }
    },
    async ({ listings, list_id }, ctx) => {
      const saved: Array<{ id: string; address: string; action: string }> = [];
      const failed: string[] = [];
      for (const listing of listings) {
        try {
          const result = await spur.data<{ action: string; property: { id: string; address?: string } }>("POST", "/zillow/save-property", {
            body: listing,
            signal: ctx.mcpReq.signal
          });
          saved.push({ id: result.property.id, address: result.property.address || listing.address.streetAddress || "", action: result.action });
        } catch (error) {
          failed.push(`${listing.address.streetAddress || listing.zpid}: ${(error as Error).message}`);
        }
      }
      if (list_id && saved.length) {
        await spur.data("POST", `/property-lists/${encodeURIComponent(list_id)}/properties`, {
          body: { property_ids: saved.map(s => s.id), added_from: "mcp" },
          signal: ctx.mcpReq.signal
        });
      }
      const lines = [
        `Saved ${saved.length} of ${listings.length} properties${list_id && saved.length ? " and added them to the list" : ""}.`,
        ...saved.map(s => `- ${s.address} (property_id: ${s.id}, ${s.action})`),
        ...(failed.length ? ["", "Failed:", ...failed.map(f => `- ${f}`)] : []),
        "",
        "Next: spur_enrich_owners finds owner contact details (costs skip-trace credits)."
      ];
      return structuredResult(lines.join("\n"), { saved, failed });
    }
  );

  registerAppTool(
    server,
    "spur_list_saved_properties",
    {
      title: "List saved properties",
      description: `List properties the user has saved in Spur, optionally filtered by city, state, list, or enrichment status. Shows cards and a map.`,
      inputSchema: z.strictObject({
        city: z.string().optional().describe("City name, e.g. \"Austin\""),
        state: z.string().optional().describe('Two-letter state, e.g. "TX"'),
        list_id: z.string().optional().describe("Only properties in this property list"),
        enrichment_status: z.enum(["pending", "enriched", "failed", "partial"]).optional().describe("Skip-trace status of the property's owner (spur_enrich)"),
        min_price: z.number().optional().describe("Minimum price in USD (rent per month for rentals)"),
        max_price: z.number().optional().describe("Maximum price in USD (rent per month for rentals)"),
        ...paginationFields
      }),
      annotations: READ_ONLY,
      _meta: widgetMeta(PROPERTY_EXPLORER_URI, "Loading saved properties…", "Saved properties")
    },
    async (args, ctx) => {
      const properties = await spur.data<SavedProperty[]>("GET", "/properties", {
        query: {
          city: args.city,
          state: args.state,
          listId: args.list_id,
          enrichmentStatus: args.enrichment_status,
          minAmount: args.min_price,
          maxAmount: args.max_price
        },
        signal: ctx.mcpReq.signal
      });
      const cards = (properties || []).map(cardFromSaved);
      if (cards.length === 0) {
        return structuredResult("No saved properties match. Use spur_search_properties to find and save some.", explorerPayload([], { title: "No saved properties", mode: "saved" }));
      }
      const page = paginate(cards, args, items => [`# ${cards.length} saved properties`, "", items.map((c, i) => cardMarkdown(c, args.offset + i)).join("\n")].join("\n"));
      return structuredResult(
        page.text,
        explorerPayload(page.items, { title: `${cards.length} saved properties`, mode: "saved", total: page.total, next_offset: page.nextOffset })
      );
    }
  );

  server.registerTool(
    "spur_get_property_stats",
    {
      title: "Property stats",
      description: "Totals for the user's saved properties: counts by status, enrichment progress and similar portfolio-level numbers.",
      annotations: READ_ONLY
    },
    async ctx => {
      const stats = await spur.data<Record<string, unknown>>("GET", "/properties/stats", { signal: ctx.mcpReq.signal });
      const entries = Object.entries(stats || {}).filter(([, v]) => typeof v !== "object");
      return textResult(`# Portfolio stats\n${bullets(entries.map(([k, v]) => [k.replace(/_/g, " "), v]))}`);
    }
  );
}

