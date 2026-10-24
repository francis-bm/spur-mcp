/**
 * QR codes: the user's tracked parent codes (Spur → QR codes), their scan activity, and which
 * postcard templates print them. Putting one on a postcard is spur_add_postcard_qr_code.
 *
 * A parent code has a destination URL. Each mailed postcard gets its own child code under it
 * (minted at send time), so scans are tracked per recipient.
 */
import * as z from "zod/v4";
import { qrParentIds, type QrCode } from "../postcardQr.js";
import type { Template } from "./mail.js";
import { bullets, confirmField, dateTime, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

interface ParentScan {
  scanned_at?: string;
  device_type?: string | null;
  city?: string | null;
  region?: string | null;
}

interface RecipientCode {
  owner_id?: string | null;
  owner_full_name?: string | null;
  property_address?: string | null;
  scan_count?: number;
  first_scanned_at?: string | null;
  last_scanned_at?: string | null;
}

interface Manager {
  redirect: { id: string; total_scan_count?: number; unique_recipient_count?: number };
  recipients: RecipientCode[];
}

const hexColor = z
  .string()
  .regex(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Use a hex color such as #111827")
  .describe("Hex color, e.g. #111827. Keep strong contrast with the background so phones can scan it");
const destinationField = z.string().min(3).max(2048).describe("Where a scan sends people, e.g. https://acme.example/offer (https:// is added if missing)");
const qrIdField = uuid("QR code").describe("QR code id from spur_list_qr_codes");

/** Postcard templates (the user's own) that print each parent QR code */
export async function templatesByQrCode(spur: ToolContext["spur"], signal: AbortSignal): Promise<Map<string, Template[]>> {
  const templates = await spur.data<Template[]>("GET", "/direct-mail/templates", { query: { type: "postcard" }, signal }).catch(() => [] as Template[]);
  const byId = new Map<string, Template[]>();
  for (const t of templates || []) {
    if (t.is_default) continue;
    for (const id of qrParentIds(t.front_html, t.back_html)) byId.set(id, [...(byId.get(id) || []), t]);
  }
  return byId;
}

export const listQrCodes = (spur: ToolContext["spur"], signal: AbortSignal) => spur.data<QrCode[]>("GET", "/direct-mail/qr-codes", { signal }).then(r => r || []);

function qrLine(qr: QrCode, templates: Template[] = []): string {
  const used = templates.length ? `; on ${templates.map(t => `"${t.name}"`).join(", ")}` : "";
  return `- **${qr.name}** (qr_code_id: ${qr.id}) → ${qr.destination_url || "no destination"} (${qr.foreground_color || "#111827"} on ${qr.background_color || "#FFFFFF"}${used})`;
}

const summary = (qr: QrCode) => ({
  id: qr.id,
  name: qr.name,
  destination_url: qr.destination_url ?? null,
  foreground_color: qr.foreground_color ?? null,
  background_color: qr.background_color ?? null,
  image_url: qr.image_url ?? null,
  redirect_url: qr.redirect_url ?? null
});

export function registerQrCodeTools({ server, spur }: ToolContext) {
  const findQr = async (id: string, signal: AbortSignal) => (await listQrCodes(spur, signal)).find(q => q.id === id);

  server.registerTool(
    "spur_list_qr_codes",
    {
      title: "List QR codes",
      description:
        "The user's tracked QR codes: destination URL, colors, and which of their postcard templates print each one. Put one on a postcard with spur_add_postcard_qr_code; see scans with spur_get_qr_code_activity.",
      annotations: READ_ONLY
    },
    async ctx => {
      const signal = ctx.mcpReq.signal;
      const [codes, usage] = await Promise.all([listQrCodes(spur, signal), templatesByQrCode(spur, signal)]);
      if (!codes.length) return textResult("No QR codes yet. Create one with spur_create_qr_code (a name and the URL a scan should open).");
      return structuredResult([`# ${codes.length} QR codes`, ...codes.map(q => qrLine(q, usage.get(q.id)))].join("\n"), {
        qr_codes: codes.map(q => ({ ...summary(q), template_ids: (usage.get(q.id) || []).map(t => t.id) }))
      });
    }
  );

  server.registerTool(
    "spur_create_qr_code",
    {
      title: "Create QR code",
      description:
        "Create a tracked QR code that sends scans to destination_url. Then add it to a postcard back with spur_add_postcard_qr_code; each mailed postcard gets its own code under it so scans are tracked per recipient.",
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Label shown in Spur, e.g. 'Spring cash offer'"),
        destination_url: destinationField,
        foreground_color: hexColor.optional(),
        background_color: hexColor.optional()
      }),
      annotations: WRITE
    },
    async (args, ctx) => {
      const qr = await spur.data<QrCode>("POST", "/direct-mail/qr-codes", { body: args, signal: ctx.mcpReq.signal });
      return structuredResult(
        [`Created QR code **${qr.name}** (qr_code_id: ${qr.id}) → ${qr.destination_url}.`, "Add it to a postcard back with spur_add_postcard_qr_code."].join("\n"),
        { qr_code: summary(qr) }
      );
    }
  );

  server.registerTool(
    "spur_update_qr_code",
    {
      title: "Edit QR code",
      description:
        "Rename a QR code, change where scans go, or change its colors. A new destination also applies to postcards already mailed with this code. Templates pick up new colors at send time.",
      inputSchema: z.strictObject({
        qr_code_id: qrIdField,
        name: z.string().min(1).max(255).optional().describe("New name for the QR code"),
        destination_url: destinationField.optional(),
        foreground_color: hexColor.optional(),
        background_color: hexColor.optional()
      }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ qr_code_id, ...updates }, ctx) => {
      if (!Object.keys(updates).length) return textResult("Nothing to change: pass a name, destination_url or color.");
      const qr = await spur.data<QrCode>("PUT", `/direct-mail/qr-codes/${encodeURIComponent(qr_code_id)}`, { body: updates, signal: ctx.mcpReq.signal });
      const changed = Object.keys(updates).map(k => k.replace(/_/g, " ")).join(", ");
      return structuredResult(
        [
          `Updated QR code **${qr.name}** (qr_code_id: ${qr.id}): ${changed}.`,
          bullets([["Destination", qr.destination_url], ["Colors", `${qr.foreground_color} on ${qr.background_color}`]]),
          updates.destination_url ? "Scans of postcards already mailed with this code now go to the new destination." : ""
        ]
          .filter(Boolean)
          .join("\n"),
        { qr_code: summary(qr) }
      );
    }
  );

  server.registerTool(
    "spur_delete_qr_code",
    {
      title: "Delete QR code",
      description:
        "Permanently delete a QR code. Refused while one of the user's postcard templates still prints it: remove it from those first with spur_remove_postcard_qr_code. Postcards already mailed keep redirecting. Confirm with the user first.",
      inputSchema: z.strictObject({ qr_code_id: qrIdField, confirm: confirmField }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ qr_code_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const using = (await templatesByQrCode(spur, signal)).get(qr_code_id) || [];
      if (using.length) {
        return {
          ...textResult(
            `Not deleted: ${using.map(t => `"${t.name}" (template_id: ${t.id})`).join(", ")} still print${using.length === 1 ? "s" : ""} this QR code, and mailing ${using.length === 1 ? "it" : "them"} would fail without it. Remove it with spur_remove_postcard_qr_code (or point those templates at another code with spur_add_postcard_qr_code), then delete.`
          ),
          isError: true
        };
      }
      await spur.request("DELETE", `/direct-mail/qr-codes/${encodeURIComponent(qr_code_id)}`, { signal });
      return textResult(`Deleted QR code ${qr_code_id}. Postcards already mailed with it keep redirecting.`);
    }
  );

  server.registerTool(
    "spur_get_qr_code_activity",
    {
      title: "QR code scans",
      description:
        "Scan activity for a QR code: totals, which mailed recipients (owners) scanned their postcard, and recent scans of the code itself. Use it to find warm leads from a postcard campaign.",
      inputSchema: z.strictObject({
        qr_code_id: qrIdField,
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum recipients and scans to list")
      }),
      annotations: READ_ONLY
    },
    async ({ qr_code_id, limit }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const qr = await findQr(qr_code_id, signal);
      if (!qr) return { ...textResult(`QR code ${qr_code_id} not found. Call spur_list_qr_codes.`), isError: true };

      const [direct, redirects] = await Promise.all([
        spur
          .data<{ scans?: ParentScan[] }>("GET", `/direct-mail/qr-codes/${encodeURIComponent(qr_code_id)}/scans`, { query: { limit }, signal })
          .then(r => r?.scans || [])
          .catch(() => [] as ParentScan[]),
        spur.data<Array<{ id: string }>>("GET", "/qr/redirects", { query: { campaignId: `direct_mail_qr:${qr_code_id}`, limit: 1 }, signal }).catch(() => [])
      ]);
      const redirectId = redirects?.[0]?.id;
      const manager = redirectId
        ? await spur.data<Manager>("GET", `/qr/redirects/${encodeURIComponent(redirectId)}/manager`, { query: { limit }, signal }).catch(() => undefined)
        : undefined;

      const recipients = manager?.recipients || [];
      const scanned = recipients.filter(r => Number(r.scan_count) > 0);
      const text = [
        `# QR code: ${qr.name}`,
        bullets([
          ["Destination", qr.destination_url],
          ["Postcards mailed with it", redirectId ? `${recipients.length}${recipients.length >= limit ? "+" : ""}` : "none yet"],
          ["Postcard scans", manager?.redirect.total_scan_count ?? (redirectId ? 0 : undefined)],
          ["Recipients who scanned", manager?.redirect.unique_recipient_count ?? (redirectId ? scanned.length : undefined)],
          ["Direct scans of the code itself", direct.length || undefined]
        ]),
        scanned.length
          ? `\n## Recipients who scanned\n${scanned
              .map(r => `- ${r.owner_full_name || "Unknown owner"}${r.owner_id ? ` (owner_id: ${r.owner_id})` : ""}${r.property_address ? `, ${r.property_address}` : ""}: ${r.scan_count} scan${r.scan_count === 1 ? "" : "s"}, last ${dateTime(r.last_scanned_at)}`)
              .join("\n")}`
          : redirectId
            ? "\nNo recipient has scanned yet."
            : "\nNo postcards have been mailed with this code yet.",
        direct.length
          ? `\n## Recent direct scans\n${direct.map(s => `- ${dateTime(s.scanned_at)}${s.device_type ? `, ${s.device_type}` : ""}${s.city ? `, ${[s.city, s.region].filter(Boolean).join(", ")}` : ""}`).join("\n")}`
          : ""
      ].join("\n");
      return structuredResult(text, {
        qr_code: summary(qr),
        totals: { postcard_scans: manager?.redirect.total_scan_count ?? 0, recipients_scanned: manager?.redirect.unique_recipient_count ?? scanned.length, direct_scans: direct.length },
        recipients: scanned
      });
    }
  );
}
