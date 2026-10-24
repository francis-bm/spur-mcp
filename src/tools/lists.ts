/**
 * Property lists: named groups of properties used for outreach and automations.
 */
import * as z from "zod/v4";
import { READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

interface PropertyList {
  id: string;
  name: string;
  description?: string | null;
  is_dynamic?: boolean;
  property_count?: number;
  created_at?: string;
}

export function registerListTools({ server, spur }: ToolContext) {
  server.registerTool(
    "spur_list_property_lists",
    {
      title: "List property lists",
      description: "All of the user's property lists with ids and sizes. Use the id with spur_list_saved_properties, spur_add_properties_to_list or outreach tools.",
      annotations: READ_ONLY
    },
    async ctx => {
      const lists = (await spur.data<PropertyList[]>("GET", "/property-lists", { signal: ctx.mcpReq.signal })) || [];
      if (!lists.length) return textResult("No property lists yet. Create one with spur_create_property_list.");
      const text = [
        `# ${lists.length} property lists`,
        ...lists.map(l => `- **${l.name}** (list_id: ${l.id})${l.property_count !== undefined ? ` — ${l.property_count} properties` : ""}${l.description ? ` — ${l.description}` : ""}`)
      ].join("\n");
      return structuredResult(text, { lists: lists.map(l => ({ id: l.id, name: l.name, property_count: l.property_count ?? null })) });
    }
  );

  server.registerTool(
    "spur_create_property_list",
    {
      title: "Create property list",
      description: "Create a property list, optionally seeding it with saved property ids.",
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("List name shown in Spur"),
        description: z.string().max(1000).optional().describe("Optional note about what the list is for"),
        property_ids: z.array(z.string()).max(500).optional().describe("Saved property ids to add right away")
      }),
      annotations: WRITE
    },
    async ({ name, description, property_ids }, ctx) => {
      const list = await spur.data<PropertyList>("POST", "/property-lists", { body: { name, description }, signal: ctx.mcpReq.signal });
      if (property_ids?.length) {
        await spur.data("POST", `/property-lists/${encodeURIComponent(list.id)}/properties`, {
          body: { property_ids, added_from: "mcp" },
          signal: ctx.mcpReq.signal
        });
      }
      return structuredResult(`Created list **${list.name}** (list_id: ${list.id})${property_ids?.length ? ` with ${property_ids.length} properties` : ""}.`, {
        list_id: list.id,
        name: list.name
      });
    }
  );

  server.registerTool(
    "spur_add_properties_to_list",
    {
      title: "Add properties to list",
      description: "Add saved properties to an existing property list.",
      inputSchema: z.strictObject({
        list_id: uuid("Property list"),
        property_ids: z.array(z.string()).min(1).max(500).describe("Saved property ids (from spur_list_saved_properties or spur_save_properties)")
      }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ list_id, property_ids }, ctx) => {
      await spur.data("POST", `/property-lists/${encodeURIComponent(list_id)}/properties`, {
        body: { property_ids, added_from: "mcp" },
        signal: ctx.mcpReq.signal
      });
      return textResult(`Added ${property_ids.length} properties to list ${list_id}.`);
    }
  );
}
