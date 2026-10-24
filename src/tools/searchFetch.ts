/**
 * Generic `search` / `fetch` pair. ChatGPT's deep research and company-knowledge modes only call
 * tools with these exact names and result shapes; Claude can use them too. They read the user's
 * own Spur data (saved properties, owners, postcard templates) and never spend credits.
 */
import * as z from "zod/v4";
import { READ_ONLY, type ToolContext } from "./shared.js";
import type { SavedProperty } from "./propertyCards.js";

interface Owner {
  id: string;
  full_name?: string | null;
  email?: string | null;
  phone_numbers?: string[] | null;
  mailing_address?: string | null;
  enrichment_status?: string;
}

interface Template {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  category?: string | null;
  front_html?: string | null;
  back_html?: string | null;
  size?: string | null;
}

const appLink = (path: string) => {
  const base = (process.env.SPUR_APP_URL || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : `spur:${path}`;
};

/** Plain text from template HTML, for fetch results */
const stripHtml = (html: string | null | undefined) =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function registerSearchFetchTools({ server, spur }: ToolContext) {
  server.registerTool(
    "search",
    {
      title: "Search Spur",
      description:
        "Search the user's saved Spur properties, owners and postcard templates by keyword (address, city, owner name, phone, email, template name). Returns ids for the fetch tool. For live listings use spur_search_properties.",
      inputSchema: z.object({ query: z.string().min(1).max(200).describe("Keywords: address, city, owner name, phone, email or template name") }),
      annotations: READ_ONLY
    },
    async ({ query }, ctx) => {
      const needle = query.toLowerCase();
      const words = needle.split(/\s+/).filter(Boolean);
      const matches = (...fields: Array<unknown>) => {
        const hay = fields.filter(Boolean).join(" ").toLowerCase();
        return words.every(w => hay.includes(w));
      };
      const [properties, owners, templates] = await Promise.all([
        spur.data<SavedProperty[]>("GET", "/properties", { signal: ctx.mcpReq.signal }).catch(() => [] as SavedProperty[]),
        spur.data<Owner[]>("GET", "/owners", { signal: ctx.mcpReq.signal }).catch(() => [] as Owner[]),
        spur.data<Template[]>("GET", "/direct-mail/templates", { query: { type: "postcard" }, signal: ctx.mcpReq.signal }).catch(() => [] as Template[])
      ]);
      const results = [
        ...(properties || [])
          .filter(p => matches(p.address, p.city, p.state, p.zip_code, p.owner_display_name, p.property_type))
          .slice(0, 15)
          .map(p => ({ id: `property:${p.id}`, title: `${p.address}, ${p.city || ""} ${p.state || ""}`.trim(), url: appLink(`/properties/${p.id}`) })),
        ...(owners || [])
          .filter(o => matches(o.full_name, o.email, o.mailing_address, ...(o.phone_numbers || [])))
          .slice(0, 15)
          .map(o => ({ id: `owner:${o.id}`, title: `Owner: ${o.full_name || "Unknown"}`, url: appLink(`/owners/${o.id}`) })),
        ...(templates || [])
          .filter(t => matches(t.name, t.description, t.category))
          .slice(0, 10)
          .map(t => ({ id: `template:${t.id}`, title: `Postcard template: ${t.name}`, url: appLink("/direct-mail") }))
      ];
      return json({ results });
    }
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch Spur record",
      description: "Fetch the full text of a record returned by search (ids look like property:…, owner:… or template:…).",
      inputSchema: z.object({ id: z.string().min(3).max(200).describe("Record id exactly as returned by search, e.g. property:<uuid>") }),
      annotations: READ_ONLY
    },
    async ({ id }, ctx) => {
      const [kind, ...rest] = id.split(":");
      const recordId = encodeURIComponent(rest.join(":"));
      if (kind === "property") {
        const p = await spur.data<SavedProperty>("GET", `/properties/${recordId}`, { signal: ctx.mcpReq.signal });
        const text = [
          `${p.address}, ${p.city || ""}, ${p.state || ""} ${p.zip_code || ""}`,
          `Price: ${p.amount ?? "n/a"} | ${p.bedrooms ?? "?"} bd / ${p.bathrooms ?? "?"} ba | ${p.sqft ?? "?"} sqft | built ${p.year_built ?? "?"}`,
          `Type: ${p.property_type ?? "n/a"} | Status: ${p.listing_status ?? "n/a"} | Enrichment: ${p.enrichment_status ?? "n/a"}`,
          p.owner_display_name ? `Listing contact: ${p.owner_display_name}` : "",
          typeof p.description === "string" ? `\n${p.description}` : ""
        ]
          .filter(Boolean)
          .join("\n");
        return json({ id, title: p.address, text, url: appLink(`/properties/${p.id}`), metadata: { type: "property" } });
      }
      if (kind === "owner") {
        const o = await spur.data<Owner>("GET", `/owners/${recordId}`, { signal: ctx.mcpReq.signal });
        const text = [
          `Owner: ${o.full_name || "Unknown"}`,
          `Phones: ${(o.phone_numbers || []).join(", ") || "none"}`,
          `Email: ${o.email || "none"}`,
          `Mailing address: ${o.mailing_address || "none"}`,
          `Enrichment: ${o.enrichment_status || "n/a"}`
        ].join("\n");
        return json({ id, title: o.full_name || "Owner", text, url: appLink(`/owners/${o.id}`), metadata: { type: "owner" } });
      }
      if (kind === "template") {
        const t = await spur.data<Template>("GET", `/direct-mail/templates/${recordId}`, { signal: ctx.mcpReq.signal });
        const text = [`${t.type} template "${t.name}" (${t.size || "6x4"})`, t.description || "", `Front: ${stripHtml(t.front_html)}`, `Back: ${stripHtml(t.back_html)}`]
          .filter(Boolean)
          .join("\n");
        return json({ id, title: t.name, text, url: appLink("/direct-mail"), metadata: { type: "template" } });
      }
      return { ...json({ error: `Unknown id "${id}". Use ids returned by search.` }), isError: true };
    }
  );
}
