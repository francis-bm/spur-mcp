/**
 * One schema for the property-search filters shared by spur_search_properties,
 * spur_parse_search_query and spur_create_search_automation.
 *
 * Tool arguments are snake_case and match the search_automation_configs
 * columns, so a filter set found by searching can be scheduled unchanged.
 * `toSearchBody` maps them onto the camelCase body /zillow/search expects.
 */
import * as z from "zod/v4";

// Keys match EVENT_DEFINITIONS in backend/src/services/propertyEventService.js
export const PROPERTY_EVENTS = [
  "new_listing", "coming_soon", "coming_soon_active", "price_drop", "price_increase", "pending", "sold",
  "back_on_market", "delisted", "open_house", "rental_listed", "rent_change", "move_in_moved_up",
  "preforeclosure", "foreclosure", "auction", "bank_owned", "distress_escalated", "fsbo", "agent_to_fsbo",
  "stale_listing", "new_construction",
  "tax_assessment_posted", "assessed_value_jump", "tax_paid_dropped", "sale_recorded", "zestimate_moved",
  "equity_gap", "price_below_assessed"
] as const;

export type PropertyEvent = (typeof PROPERTY_EVENTS)[number];

/** Only scheduled automations can detect these (they need a complete prior pull to diff). */
export const AUTOMATION_ONLY_EVENTS: readonly PropertyEvent[] = ["delisted"];

export const EVENT_LABELS: Record<PropertyEvent, string> = {
  new_listing: "New listing",
  coming_soon: "Coming soon posted",
  coming_soon_active: "Coming soon went active",
  price_drop: "Price drop",
  price_increase: "Price increase",
  pending: "Went pending",
  sold: "Sold",
  back_on_market: "Back on market",
  delisted: "Delisted / withdrawn",
  open_house: "Open house scheduled",
  rental_listed: "Rental listed",
  rent_change: "Rent change",
  move_in_moved_up: "Move-in date moved up",
  preforeclosure: "Entered pre-foreclosure",
  foreclosure: "Entered foreclosure",
  auction: "Went to auction",
  bank_owned: "Became bank-owned (REO)",
  distress_escalated: "Distress stage escalated",
  fsbo: "FSBO listing appeared",
  agent_to_fsbo: "Agent listing expired into FSBO",
  stale_listing: "Listing went stale",
  new_construction: "New construction released",
  tax_assessment_posted: "New tax assessment posted",
  assessed_value_jump: "Assessed value jumped",
  tax_paid_dropped: "Tax paid dropped (weak signal)",
  sale_recorded: "Sale recorded",
  zestimate_moved: "Zestimate moved",
  equity_gap: "Equity gap",
  price_below_assessed: "Price below assessed value"
};

export const EVENTS_GUIDE = `Events (pass in \`events\`; a listing matches when ANY selected event fired, and is tagged with each):
- Listing lifecycle: new_listing, coming_soon, coming_soon_active, price_drop, price_increase, pending, sold, back_on_market, delisted (automations only), open_house, rental_listed, rent_change, move_in_moved_up
- Distress & motivation: preforeclosure, foreclosure, auction, bank_owned, distress_escalated, fsbo, agent_to_fsbo, stale_listing, new_construction
- Valuation & tax: tax_assessment_posted, assessed_value_jump, tax_paid_dropped (weak), sale_recorded, zestimate_moved, equity_gap, price_below_assessed
Direct events (price_drop, pending, sold, preforeclosure, fsbo, new_listing, …) work on the first search. Change events (price_increase, back_on_market, distress_escalated, agent_to_fsbo, rent_change, zestimate_moved, …) compare against what Spur saw on an earlier search of the same area, so the first search only records a baseline.
Motivated-seller research usually combines price_drop, back_on_market, stale_listing, agent_to_fsbo and the distress stages.`;

const HOME_TYPES = ["singleFamily", "condo,apartment", "townhome", "multiFamily", "manufactured", "land"] as const;
const LISTING_TYPES = ["fsba", "fsbo", "newConstruction", "foreclosure", "preforeclosure", "foreclosed", "auction"] as const;

const money = () => z.number().min(0);
const count = () => z.number().int().min(0).max(20);
const zip = z.string().regex(/^\d{5}$/, "5-digit ZIP");

/** Filters stored on automations as well as used by search. */
export const sharedFilterShape = {
  home_type: z.enum(HOME_TYPES).optional().describe("Zillow home type code"),
  listing_type: z.enum(LISTING_TYPES).optional().describe("Seller / listing kind; for catching NEW entries into a distress stage prefer events"),
  min_beds: count().optional().describe("Minimum bedrooms"),
  max_beds: count().optional().describe("Maximum bedrooms"),
  min_baths: z.number().min(0).max(20).optional().describe("Minimum bathrooms (half baths count as 0.5)"),
  max_baths: z.number().min(0).max(20).optional().describe("Maximum bathrooms"),
  min_sqft: z.number().int().min(0).optional().describe("Minimum living area in square feet"),
  max_sqft: z.number().int().min(0).optional().describe("Maximum living area in square feet"),
  min_lot_size: z.number().int().min(0).optional().describe("Square feet (1 acre = 43,560)"),
  max_lot_size: z.number().int().min(0).optional().describe("Square feet"),
  min_year_built: z.number().int().min(1700).max(2100).optional().describe("Built in or after this year"),
  max_year_built: z.number().int().min(1700).max(2100).optional().describe("Built in or before this year"),
  min_age: z.number().int().min(0).max(400).optional().describe("Years since built"),
  max_age: z.number().int().min(0).max(400).optional().describe("At most this many years since built"),
  days_posted: z.number().int().min(1).max(3650).optional().describe("Only listings posted within this many days"),
  min_days_on_market: z.number().int().min(0).optional().describe("Listed at least this many days (higher suggests a motivated seller)"),
  max_days_on_market: z.number().int().min(0).optional().describe("Listed at most this many days"),
  keywords: z.string().max(300).optional().describe("Comma-separated listing keywords, e.g. \"pool, granite\""),
  has_pool: z.boolean().optional().describe("true = only listings with a pool"),
  has_garage: z.boolean().optional().describe("true = only listings with a garage"),
  has_view: z.boolean().optional().describe("true = only listings with any view (use views on live search for a specific kind)"),
  is_waterfront: z.boolean().optional().describe("true = only waterfront listings"),
  is_price_reduced: z.boolean().optional().describe("true = only listings whose asking price has been cut"),
  // Geography (post-filters on the fetched results)
  zip_list: z.array(zip).min(1).max(50).optional().describe("Keep only these ZIPs; set location to the city that contains them"),
  neighborhoods: z.array(z.string().min(1).max(80)).min(1).max(20).optional().describe("Neighborhood / area names matched against address and description"),
  center_lat: z.number().min(-90).max(90).optional().describe("Radius search centre (with center_lng and radius_miles)"),
  center_lng: z.number().min(-180).max(180).optional().describe("Radius search centre longitude (with center_lat and radius_miles)"),
  radius_miles: z.number().min(0).max(500).optional().describe("Keep only listings within this many miles of center_lat / center_lng"),
  min_zip: z.number().int().min(0).max(99999).optional().describe("Lowest ZIP code in a numeric ZIP range (with max_zip); prefer zip_list for specific ZIPs"),
  max_zip: z.number().int().min(0).max(99999).optional().describe("Highest ZIP code in a numeric ZIP range (with min_zip)"),
  // Owner heuristics
  only_absentee: z.boolean().optional().describe("Absentee-owned (owner mails elsewhere)"),
  only_vacant: z.boolean().optional().describe("Likely vacant (heuristic: description keywords + long days on market)"),
  only_pre_foreclosure: z.boolean().optional().describe("Distressed / pre-foreclosure (heuristic, includes description keywords)"),
  ownership_type: z.enum(["individual", "business", "any"]).optional().describe("business = LLC / corp / trust owners (heuristic)"),
  min_equity: money().optional().describe("Estimated equity in USD (Zestimate or price minus assessed value; rough)"),
  min_ownership_years: z.number().min(0).max(150).optional().describe("Owner has held the property at least this long"),
  max_ownership_years: z.number().min(0).max(150).optional().describe("Owner has held the property at most this long"),
  // Events
  events: z.array(z.enum(PROPERTY_EVENTS)).min(1).max(15).optional().describe("Only listings where any of these events happened; see the tool description"),
  event_within_days: z.number().int().min(1).max(365).optional().describe("Lookback window for events, in days (default 7)"),
  event_min_change_pct: z.number().min(0).max(100).optional().describe("Minimum % move for price / rent / Zestimate / assessment events"),
  event_stale_days: z.number().int().min(1).max(3650).optional().describe("Days on market that counts as stale (default 90)"),
  event_min_equity_gap_pct: z.number().min(0).max(1000).optional().describe("Minimum % Zestimate above last sale price for equity_gap (default 30)")
};

/** Live-search-only filters (not stored on automations). */
export const searchOnlyFilterShape = {
  is_single_story: z.boolean().optional().describe("true = only single-story homes"),
  has_air_conditioning: z.boolean().optional().describe("true = only listings with air conditioning"),
  has_open_house: z.boolean().optional().describe("true = only listings with an upcoming open house"),
  has_3d_tour: z.boolean().optional().describe("true = only listings with a 3D virtual tour"),
  views: z.array(z.enum(["water", "city", "mountain", "park", "golfCourse"])).min(1).optional().describe("Only listings with any of these view types")
};

// snake_case arg → camelCase /zillow/search field, where the generic rule doesn't fit
const SEARCH_KEY_OVERRIDES: Record<string, string> = {
  min_price: "minAmount",
  max_price: "maxAmount",
  listing_status: "status",
  query: "aiQuery",
  has_3d_tour: "has3DTour"
};
const toCamel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** Map tool arguments onto the /zillow/search body; drops unset values and non-filter args. */
export function toSearchBody(args: Record<string, unknown>, skip: string[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (skip.includes(key) || value === undefined || value === null) continue;
    body[SEARCH_KEY_OVERRIDES[key] || toCamel(key)] = value;
  }
  return body;
}

const SEARCH_KEY_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(SEARCH_KEY_OVERRIDES).map(([snake, camel]) => [camel, snake])
);
const toSnake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/**
 * Map parsed camelCase filters back onto spur_search_properties argument
 * names, keeping only those the tool accepts. Returns the unknown leftovers too.
 */
export function fromParsedFilters(parsed: Record<string, unknown>, allowed: string[]): { args: Record<string, unknown>; ignored: string[] } {
  const args: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === null || key === "semanticIntent") continue;
    const snake = SEARCH_KEY_REVERSE[key] || toSnake(key);
    if (allowed.includes(snake)) args[snake] = value;
    else ignored.push(key);
  }
  return { args, ignored };
}

/** Short human list of the filters a search actually applied. */
export function describeFilters(args: Record<string, unknown>, skip: string[] = []): string {
  return Object.entries(args)
    .filter(([k, v]) => !skip.includes(k) && v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : String(v)}`)
    .join(", ");
}
