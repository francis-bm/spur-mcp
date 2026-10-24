/**
 * One card shape for both live listings (Zillow search rows) and saved Spur properties,
 * so the explorer widget and the markdown summaries render them the same way.
 */
import { bullets, money } from "./shared.js";

export interface ZillowListing {
  zpid: number | string;
  address?: { streetAddress?: string; city?: string; state?: string; zipcode?: string };
  location?: { latitude?: number; longitude?: number };
  price?: number;
  pricePerSquareFoot?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  livingArea?: number;
  yearBuilt?: number | null;
  lotSize?: number | null;
  lotSizeUnit?: string | null;
  datePosted?: string;
  daysOnZillow?: number;
  listingStatus?: string;
  photoUrl?: string;
  zestimate?: number | null;
  rentZestimate?: number | null;
  taxAssessedValue?: number | null;
  detailUrl?: string;
  rentalListingOwnerContact?: { displayName?: string | null; phoneNumber?: string | null };
  /** Event keys this listing matched (event searches only) */
  events?: string[];
  /** Per-event specifics, e.g. { price_drop: { previousPrice, price, changePct } } */
  eventDetails?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

export interface SavedProperty {
  id: string;
  zpid?: number | string | null;
  address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  latitude?: number | string | null;
  longitude?: number | string | null;
  amount?: number | string | null;
  property_type?: string;
  bedrooms?: number | null;
  bathrooms?: number | string | null;
  sqft?: number | null;
  year_built?: number | null;
  days_on_zillow?: number | null;
  listing_status?: string | null;
  photo_url?: string | null;
  zestimate?: number | string | null;
  rent_zestimate?: number | string | null;
  zillow_url?: string | null;
  owner_display_name?: string | null;
  enrichment_status?: string | null;
  [key: string]: unknown;
}

export interface PropertyCard {
  key: string;
  source: "listing" | "saved";
  propertyId?: string;
  zpid?: string;
  address: string;
  cityLine: string;
  lat?: number;
  lng?: number;
  price?: number;
  listingStatus?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  propertyType?: string;
  photoUrl?: string;
  daysOnMarket?: number;
  zestimate?: number;
  rentZestimate?: number;
  url?: string;
  contactName?: string;
  enrichmentStatus?: string;
  /** Matched events with a short detail each, e.g. "price_drop (-10%)" */
  events?: string[];
  /** Compact listing payload the widget sends back to spur_save_properties */
  listing?: ZillowListing;
}

const num = (value: unknown): number | undefined => {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) || n === 0 ? undefined : n;
};

const PROPERTY_TYPE_LABELS: Record<string, string> = {
  singleFamily: "Single family",
  SINGLE_FAMILY: "Single family",
  condo: "Condo",
  CONDO: "Condo",
  townhouse: "Townhouse",
  TOWNHOUSE: "Townhouse",
  multiFamily: "Multi-family",
  MULTI_FAMILY: "Multi-family",
  apartment: "Apartment",
  APARTMENT: "Apartment",
  manufactured: "Manufactured",
  lot: "Lot / land",
  LOT: "Lot / land"
};

const typeLabel = (value: unknown) => (typeof value === "string" && value ? PROPERTY_TYPE_LABELS[value] || value.replace(/_/g, " ") : undefined);

/** Keeps only what saving needs; photos arrays and descriptions are dropped to keep payloads small */
export function compactListing(listing: ZillowListing): ZillowListing {
  const { allPhotos: _photos, description: _description, listingSubType: _sub, eventDetails: _details, ...rest } = listing;
  return rest;
}

/** "price_drop (-10%: $300,000 → $270,000)" style label for one matched event */
export function eventLabel(key: string, details?: Record<string, unknown>): string {
  if (!details) return key;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const pct = n(details.changePct) ?? n(details.gapPct) ?? (n(details.belowPct) !== undefined ? -n(details.belowPct)! : undefined);
  const from = n(details.previousPrice) ?? n(details.previousRent) ?? n(details.previousZestimate) ?? n(details.previousValue) ?? n(details.lastSalePrice);
  const to = n(details.price) ?? n(details.rent) ?? n(details.zestimate) ?? n(details.value);
  const parts: string[] = [];
  if (pct !== undefined) parts.push(`${pct > 0 ? "+" : ""}${pct}%`);
  if (from !== undefined && to !== undefined) parts.push(`${money(from)} → ${money(to)}`);
  if (typeof details.from === "string" && typeof details.to === "string") parts.push(`${details.from} → ${details.to}`);
  if (typeof details.previousStatus === "string") parts.push(`was ${details.previousStatus}`);
  if (n(details.daysOnZillow) !== undefined) parts.push(`${details.daysOnZillow} days on market`);
  if (typeof details.saleDate === "string") parts.push(`sold ${details.saleDate}`);
  return parts.length ? `${key} (${parts.join(": ")})` : key;
}

export function cardFromListing(listing: ZillowListing): PropertyCard {
  const a = listing.address || {};
  return {
    key: `z${listing.zpid}`,
    source: "listing",
    zpid: String(listing.zpid),
    address: a.streetAddress || "Address unavailable",
    cityLine: [a.city, [a.state, a.zipcode].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    lat: num(listing.location?.latitude),
    lng: num(listing.location?.longitude),
    price: num(listing.price),
    listingStatus: listing.listingStatus,
    beds: num(listing.bedrooms),
    baths: num(listing.bathrooms),
    sqft: num(listing.livingArea),
    yearBuilt: num(listing.yearBuilt),
    propertyType: typeLabel(listing.propertyType),
    photoUrl: listing.photoUrl || undefined,
    daysOnMarket: listing.daysOnZillow ?? undefined,
    zestimate: num(listing.zestimate),
    rentZestimate: num(listing.rentZestimate),
    url: listing.detailUrl,
    contactName: listing.rentalListingOwnerContact?.displayName || undefined,
    events: listing.events?.length ? listing.events.map(e => eventLabel(e, listing.eventDetails?.[e])) : undefined,
    listing: compactListing(listing)
  };
}

export function cardFromSaved(property: SavedProperty): PropertyCard {
  return {
    key: `p${property.id}`,
    source: "saved",
    propertyId: property.id,
    zpid: property.zpid ? String(property.zpid) : undefined,
    address: property.address || "Address unavailable",
    cityLine: [property.city, [property.state, property.zip_code].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    lat: num(property.latitude),
    lng: num(property.longitude),
    price: num(property.amount),
    listingStatus: property.listing_status || undefined,
    beds: num(property.bedrooms),
    baths: num(property.bathrooms),
    sqft: num(property.sqft),
    yearBuilt: num(property.year_built),
    propertyType: typeLabel(property.property_type),
    photoUrl: property.photo_url || undefined,
    daysOnMarket: property.days_on_zillow ?? undefined,
    zestimate: num(property.zestimate),
    rentZestimate: num(property.rent_zestimate),
    url: property.zillow_url || undefined,
    contactName: property.owner_display_name || undefined,
    enrichmentStatus: property.enrichment_status || undefined
  };
}

export function priceLabel(card: PropertyCard): string {
  if (!card.price) return "Price n/a";
  return card.listingStatus === "forRent" ? `${money(card.price)}/mo` : money(card.price);
}

/** One compact markdown block per card; ids in parentheses so the model can act on them */
export function cardMarkdown(card: PropertyCard, index?: number): string {
  const facts = [
    card.beds ? `${card.beds} bd` : null,
    card.baths ? `${card.baths} ba` : null,
    card.sqft ? `${card.sqft.toLocaleString()} sqft` : null,
    card.propertyType,
    card.yearBuilt ? `built ${card.yearBuilt}` : null
  ]
    .filter(Boolean)
    .join(" · ");
  const id = card.propertyId ? `property_id: ${card.propertyId}` : `zpid: ${card.zpid}`;
  const heading = `${index !== undefined ? `${index + 1}. ` : ""}**${card.address}**, ${card.cityLine} — ${priceLabel(card)} (${id})`;
  const extra = bullets([
    ["Facts", facts || undefined],
    ["Zestimate", card.zestimate ? money(card.zestimate) : undefined],
    ["Rent Zestimate", card.rentZestimate ? `${money(card.rentZestimate)}/mo` : undefined],
    ["Events", card.events?.length ? card.events.join("; ") : undefined],
    ["Days on market", card.daysOnMarket],
    ["Listing contact", card.contactName],
    ["Enrichment", card.enrichmentStatus]
  ]);
  return extra ? `${heading}\n${extra.replace(/^/gm, "   ")}` : heading;
}
