/**
 * Owners and skip-trace enrichment.
 */
import * as z from "zod/v4";
import { bullets, confirmField, date, money, OUTWARD, paginate, paginationFields, READ_ONLY, structuredResult, textResult, uuid, type ToolContext } from "./shared.js";

interface Owner {
  id: string;
  full_name?: string | null;
  email?: string | null;
  phone_numbers?: string[] | null;
  mailing_address?: string | null;
  property_count?: number;
  enrichment_status?: string;
  contact_status?: string | null;
  responded?: boolean | null;
  confidence_score?: number | null;
  enrichment_date?: string | null;
  primary_contact?: Record<string, unknown> | null;
}

interface Portfolio {
  properties?: Array<{ id: string; address?: string; city?: string; state?: string; amount?: number; ownership_type?: string; is_occupied?: boolean }>;
  stats?: { total?: number; occupied?: number; notOccupied?: number };
}

function ownerLine(owner: Owner, index?: number): string {
  const contact = [owner.phone_numbers?.[0], owner.email].filter(Boolean).join(" · ");
  const parts = [
    `${index !== undefined ? `${index + 1}. ` : ""}**${owner.full_name || "Unknown owner"}** (owner_id: ${owner.id})`,
    owner.property_count !== undefined ? `${owner.property_count} propert${owner.property_count === 1 ? "y" : "ies"}` : null,
    owner.enrichment_status ? `enrichment: ${owner.enrichment_status}` : null,
    contact || "no contact info yet"
  ];
  return parts.filter(Boolean).join(" — ");
}

export function registerOwnerTools({ server, spur }: ToolContext) {
  server.registerTool(
    "spur_find_owners",
    {
      title: "Find owners",
      description: `Find property owners in the user's Spur account by name, phone, email or mailing address text. Use spur_get_owner for full details and portfolio.`,
      inputSchema: z.strictObject({
        query: z.string().max(200).optional().describe("Text to match against name, email, phone or mailing address"),
        enrichment_status: z.enum(["enriched", "pending", "failed", "partial", "not_enriched"]).optional().describe("Only owners with this skip-trace status"),
        has_phone: z.boolean().optional().describe("Only owners with at least one phone number"),
        ...paginationFields
      }),
      annotations: READ_ONLY
    },
    async ({ query, enrichment_status, has_phone, limit, offset }, ctx) => {
      const owners = (await spur.data<Owner[]>("GET", "/owners", { signal: ctx.mcpReq.signal })) || [];
      const needle = query?.toLowerCase().trim();
      const matches = owners.filter(o => {
        if (enrichment_status && o.enrichment_status !== enrichment_status) return false;
        if (has_phone && !(o.phone_numbers && o.phone_numbers.length)) return false;
        if (!needle) return true;
        return [o.full_name, o.email, o.mailing_address, ...(o.phone_numbers || [])].some(v => v && String(v).toLowerCase().includes(needle));
      });
      if (matches.length === 0) {
        return textResult(query ? `No owners match "${query}".` : "No owners yet. Save properties and run spur_enrich to find owners.");
      }
      const page = paginate(matches, { limit, offset }, items => [`# ${matches.length} owners`, "", ...items.map((o, i) => ownerLine(o, offset + i))].join("\n"));
      return structuredResult(page.text, {
        total: page.total,
        owners: page.items.map(o => ({ id: o.id, name: o.full_name, phones: o.phone_numbers || [], email: o.email, enrichment_status: o.enrichment_status })),
        ...(page.nextOffset !== undefined ? { next_offset: page.nextOffset } : {})
      });
    }
  );

  server.registerTool(
    "spur_get_owner",
    {
      title: "Get owner",
      description: "Full owner record: contact details, mailing address, enrichment status and their property portfolio in Spur.",
      inputSchema: z.strictObject({ owner_id: uuid("Owner") }),
      annotations: READ_ONLY
    },
    async ({ owner_id }, ctx) => {
      const id = encodeURIComponent(owner_id);
      const [owner, portfolio] = await Promise.all([
        spur.data<Owner>("GET", `/owners/${id}`, { signal: ctx.mcpReq.signal }),
        spur.data<Portfolio>("GET", `/owners/${id}/portfolio`, { signal: ctx.mcpReq.signal }).catch(() => ({}) as Portfolio)
      ]);
      const properties = portfolio.properties || [];
      const text = [
        `# ${owner.full_name || "Unknown owner"} (owner_id: ${owner.id})`,
        bullets([
          ["Phones", owner.phone_numbers?.length ? owner.phone_numbers.join(", ") : "none on file"],
          ["Email", owner.email],
          ["Mailing address", owner.mailing_address],
          ["Enrichment", owner.enrichment_status],
          ["Last enriched", owner.enrichment_date ? date(owner.enrichment_date) : undefined],
          ["Contact status", owner.contact_status],
          ["Has replied", owner.responded ? "yes" : undefined]
        ]),
        "",
        `## Portfolio (${properties.length})`,
        properties.length
          ? properties
              .map(p => `- ${p.address || "Unknown address"}, ${p.city || ""} ${p.state || ""} — ${money(p.amount)} (property_id: ${p.id})${p.is_occupied === false ? " · not occupied" : ""}`)
              .join("\n")
          : "No linked properties."
      ].join("\n");
      return textResult(text);
    }
  );

  server.registerTool(
    "spur_enrich",
    {
      title: "Skip trace / enrich",
      description: `Run skip tracing to find owners and their phone numbers, emails and mailing addresses.
- property_ids: find the owner of saved properties (creates/links owner records)
- owner_ids: refresh contact details for existing owners

Costs enrichment credits per record (check spur_get_billing_summary). Ask the user to approve the count first, then call with confirm=true.`,
      inputSchema: z.strictObject({
        property_ids: z.array(z.string()).max(100).optional().describe("Saved property ids whose owners to skip-trace"),
        owner_ids: z.array(z.string()).max(100).optional().describe("Owner ids to skip-trace (from spur_find_owners)"),
        confirm: confirmField
      }),
      annotations: OUTWARD
    },
    async ({ property_ids, owner_ids }, ctx) => {
      const lines: string[] = [];
      if (property_ids?.length) {
        const results = await spur.data<Array<{ success?: boolean; propertyId?: string; error?: string }>>("POST", "/enrichment/bulk", {
          body: { propertyIds: property_ids },
          signal: ctx.mcpReq.signal
        });
        const list = Array.isArray(results) ? results : [];
        const ok = list.filter(r => r.success !== false).length;
        lines.push(`Properties: ${ok} of ${property_ids.length} enriched.`);
        for (const r of list.filter(r => r.success === false)) lines.push(`- ${r.propertyId || "property"}: ${r.error || "failed"}`);
      }
      if (owner_ids?.length) {
        const result = await spur.request<{ results?: Array<{ success?: boolean; ownerId?: string; error?: string }>; summary?: { total?: number; success?: number; failed?: number } }>(
          "POST",
          "/owners/bulk-enrich",
          { body: { ownerIds: owner_ids }, signal: ctx.mcpReq.signal }
        );
        const ok = result.summary?.success ?? (result.results || []).filter(r => r.success).length;
        lines.push(`Owners: ${ok} of ${owner_ids.length} enriched.`);
        for (const r of (result.results || []).filter(r => !r.success)) lines.push(`- ${r.ownerId || "owner"}: ${r.error || "failed"}`);
      }
      if (!lines.length) return { ...textResult("Pass property_ids and/or owner_ids."), isError: true };
      lines.push("", "Use spur_find_owners or spur_get_owner to see the new contact details.");
      return textResult(lines.join("\n"));
    }
  );
}
