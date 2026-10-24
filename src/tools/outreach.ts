/**
 * Outreach: AI drafting, workflows, SMS and the reply inbox.
 */
import * as z from "zod/v4";
import { createMessageHelpers, type MessageTemplate } from "./messageTemplates.js";
import { bullets, confirmField, dateTime, OUTWARD, READ_ONLY, structuredResult, textResult, uuid, WRITE, type ToolContext } from "./shared.js";

interface WorkflowStep {
  id: string;
  step_type: string;
  step_order: number;
  config?: Record<string, unknown> | null;
  parent_step_id?: string | null;
  branch_condition?: string | null;
}

interface Workflow {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
  is_active?: boolean;
  trigger_type?: string | null;
  trigger_config?: Record<string, unknown> | null;
  enrolled_count?: number;
  completed_count?: number;
  steps?: WorkflowStep[];
}

interface DirectMailTemplate {
  id: string;
  name: string;
  type: "postcard" | "letter";
  size?: string | null;
}

const SEND_STEPS = ["send_email", "send_sms", "send_direct_mail"] as const;
type SendStep = (typeof SEND_STEPS)[number];
const SEND_CHANNEL: Record<SendStep, "email" | "sms" | "direct_mail"> = { send_email: "email", send_sms: "sms", send_direct_mail: "direct_mail" };

const STEP_LABELS: Record<string, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  send_direct_mail: "Send direct mail",
  wait: "Wait",
  on_reply: "If they reply",
  on_open: "If they open",
  on_click: "If they click",
  on_scan: "If they scan the QR code",
  no_reply: "If no reply",
  no_open: "If not opened",
  no_click: "If not clicked",
  no_scan: "If not scanned",
  on_subscribe: "On subscribe",
  on_unsubscribe: "On unsubscribe"
};

function describeStep(step: WorkflowStep, templateNames: Map<string, string>): string {
  const c = step.config || {};
  const label = STEP_LABELS[step.step_type] || step.step_type;
  if ((SEND_STEPS as readonly string[]).includes(step.step_type)) {
    const id = c.template_id as string | undefined;
    const name = id ? templateNames.get(id) || (c.template_name as string | undefined) || "unknown template" : undefined;
    return `${label}: ${id ? `"${name}" (template_id: ${id})` : "⚠️ no template set"}`;
  }
  if (step.step_type === "wait") {
    const parts = [c.days || c.wait_days ? `${c.days || c.wait_days}d` : "", c.hours ? `${c.hours}h` : "", c.minutes ? `${c.minutes}m` : ""].filter(Boolean);
    return `${label} ${parts.join(" ") || "1d"}`;
  }
  if (step.step_type.startsWith("on_")) return `${label} (within ${c.timeout_days || 7} days)`;
  if (step.step_type.startsWith("no_")) return `${label} (after ${c.wait_days || 7} days)`;
  return label;
}

/** Steps as the backend's update endpoint expects them; omitted steps are deleted, so always send all */
const stepPayload = (s: WorkflowStep) => ({
  id: s.id,
  step_type: s.step_type,
  step_order: s.step_order,
  config: s.config || {},
  parent_step_id: s.parent_step_id ?? null,
  branch_condition: s.branch_condition ?? null
});

const stepInput = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("send_email"), template_id: uuid("Email template"), send_as_reply: z.boolean().optional().describe("Reply in the previous email's thread") }),
  z.strictObject({ type: z.literal("send_sms"), template_id: uuid("SMS template") }),
  z.strictObject({
    type: z.literal("send_direct_mail"),
    template_id: uuid("Saved postcard or letter template (spur_list_postcard_templates / spur_list_letter_templates; copy gallery designs first)"),
    return_address_id: z.string().optional()
  }),
  z.strictObject({
    type: z.literal("wait"),
    days: z.number().int().min(0).max(365).default(0),
    hours: z.number().int().min(0).max(23).default(0)
  })
]);

interface SmsMessage {
  id: string;
  direction: "inbound" | "outbound";
  message: string;
  status?: string;
  sent_at?: string;
  read_at?: string | null;
}

interface Conversation {
  owner: { id: string; full_name?: string | null; phone_numbers?: string[] | null; contact_status?: string | null };
  lastMessage?: SmsMessage;
  unreadCount: number;
}

export function registerOutreachTools({ server, spur }: ToolContext) {
  server.registerTool(
    "spur_draft_message",
    {
      title: "Draft outreach message",
      description: `Draft an email, SMS or direct-mail message with Spur's AI. Returns text only; nothing is sent. Pass owner_id/property_id to personalize with real owner and property data.

Uses 1 AI credit. Use {{merge_fields}} like {{owner_first_name}} and {{property_address}} to keep it reusable (see resource spur://merge-variables).`,
      inputSchema: z.strictObject({
        channel: z.enum(["email", "sms", "direct_mail"]).describe("Which kind of message to draft"),
        prompt: z.string().min(3).max(2000).describe('What to write, e.g. "friendly first touch asking if they would sell, mention we close in cash"'),
        owner_id: z.string().optional().describe("Owner to personalize for (from spur_find_owners)"),
        property_id: z.string().optional().describe("Saved property the message is about")
      }),
      annotations: { ...WRITE, idempotentHint: false }
    },
    async ({ channel, prompt, owner_id, property_id }, ctx) => {
      let context: Record<string, unknown> = {};
      if (owner_id || property_id) {
        context = await spur
          .data<Record<string, unknown>>("POST", "/communication/template-data/build", {
            body: { owner_id, property_id },
            signal: ctx.mcpReq.signal
          })
          .catch(() => ({}));
      }
      const result = await spur.data<{ content: unknown }>("POST", "/communication/ai/generate-from-prompt", {
        body: { prompt, template_type: channel, context },
        signal: ctx.mcpReq.signal
      });
      const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2);
      return structuredResult(`Draft (${channel.replace("_", " ")}), not sent:\n\n${content}`, { channel, content: result.content });
    }
  );

  server.registerTool(
    "spur_list_workflows",
    {
      title: "List outreach workflows",
      description: "The user's multi-step outreach workflows (email/SMS/mail sequences) with status and enrollment counts.",
      annotations: READ_ONLY
    },
    async ctx => {
      const workflows = (await spur.data<Workflow[]>("GET", "/outreach/workflows", { signal: ctx.mcpReq.signal })) || [];
      if (!workflows.length) return textResult("No outreach workflows yet. Create them in Spur → Outreach.");
      const text = [
        `# ${workflows.length} outreach workflows`,
        ...workflows.map(
          w =>
            `- **${w.name}** (workflow_id: ${w.id}) — ${w.is_active ? "active" : w.status || "inactive"}, ${w.enrolled_count ?? 0} enrolled, ${w.completed_count ?? 0} completed${Array.isArray(w.steps) ? `, ${w.steps.length} steps` : ""}`
        )
      ].join("\n");
      return structuredResult(text, { workflows: workflows.map(w => ({ id: w.id, name: w.name, active: !!w.is_active })) });
    }
  );

  const messages = createMessageHelpers(spur);

  const loadWorkflow = (id: string, signal: AbortSignal) => spur.data<Workflow>("GET", `/outreach/workflows/${encodeURIComponent(id)}`, { signal });

  /** Names for every template a workflow's steps point at, from both template stores */
  const templateNames = async (signal: AbortSignal) => {
    const [comms, mail] = await Promise.all([
      messages.listTemplates(undefined, signal).catch(() => [] as MessageTemplate[]),
      spur.data<DirectMailTemplate[]>("GET", "/direct-mail/templates", { signal }).catch(() => [] as DirectMailTemplate[])
    ]);
    return new Map<string, string>([...comms.map(t => [t.id, t.template_name] as [string, string]), ...(mail || []).map(t => [t.id, t.name] as [string, string])]);
  };

  /**
   * Checks a template fits the send step and returns the step config the Spur workflow builder
   * saves for it (direct mail also records which template store and mail type it came from).
   */
  const sendStepConfig = async (stepType: SendStep, templateId: string, signal: AbortSignal, extra: Record<string, unknown> = {}) => {
    if (stepType === "send_direct_mail") {
      const t = await spur.data<DirectMailTemplate>("GET", `/direct-mail/templates/${encodeURIComponent(templateId)}`, { signal });
      return {
        template_id: t.id,
        template_name: t.name,
        template_source: "direct_mail",
        mail_type: t.type,
        ...(t.type === "postcard" ? { postcard_size: t.size || "6x4" } : {}),
        ...extra
      };
    }
    const t = await messages.loadTemplate(templateId, SEND_CHANNEL[stepType] as "email" | "sms", signal);
    return { template_id: t.id, template_name: t.template_name, template_source: "communication", ...extra };
  };

  const workflowText = (w: Workflow, names: Map<string, string>) => {
    const steps = [...(w.steps || [])].sort((a, b) => a.step_order - b.step_order);
    const top = steps.filter(s => !s.parent_step_id);
    const lines: string[] = [];
    top.forEach((step, i) => {
      lines.push(`${i + 1}. ${describeStep(step, names)} (step_id: ${step.id})`);
      for (const child of steps.filter(s => s.parent_step_id === step.id)) {
        lines.push(`   - [${child.branch_condition || "branch"}] ${describeStep(child, names)} (step_id: ${child.id})`);
      }
    });
    const missing = steps.filter(s => (SEND_STEPS as readonly string[]).includes(s.step_type) && !s.config?.template_id).length;
    return [
      `# ${w.name} (workflow_id: ${w.id})`,
      bullets([
        ["Status", w.is_active ? "active" : w.status || "draft"],
        ["Description", w.description],
        ["Enrolled", w.enrolled_count]
      ]),
      lines.length ? `\n## Steps\n${lines.join("\n")}` : "\nNo steps yet.",
      missing ? `\n⚠️ ${missing} send step${missing === 1 ? " has" : "s have"} no template; set one with spur_set_workflow_step_template before activating.` : ""
    ].join("\n");
  };

  server.registerTool(
    "spur_get_workflow",
    {
      title: "Get outreach workflow",
      description: "One outreach workflow's steps in order (including reply/open branches built in the app), with the email, SMS or mail template each send step uses and its step_id.",
      inputSchema: z.strictObject({ workflow_id: uuid("Workflow") }),
      annotations: READ_ONLY
    },
    async ({ workflow_id }, ctx) => {
      const [w, names] = await Promise.all([loadWorkflow(workflow_id, ctx.mcpReq.signal), templateNames(ctx.mcpReq.signal)]);
      return structuredResult(workflowText(w, names), {
        workflow_id: w.id,
        active: !!w.is_active,
        steps: (w.steps || []).map(s => ({ id: s.id, type: s.step_type, order: s.step_order, template_id: (s.config?.template_id as string) ?? null, parent_step_id: s.parent_step_id ?? null }))
      });
    }
  );

  server.registerTool(
    "spur_create_workflow",
    {
      title: "Create outreach workflow",
      description: `Create a multi-step outreach sequence from saved templates. It's saved as an inactive draft: nothing sends until it's activated (spur_set_workflow_active) and owners are enrolled.

Send steps take a saved template: email/SMS from spur_list_message_templates (design new ones with spur_create_email_template / spur_create_sms_template), direct mail from the user's saved postcard or letter templates. Wait steps space them out. Reply/open/click branches can be added afterwards in Spur → Outreach.

Example: "text, wait 2 days, email, wait 5 days, postcard" -> steps=[{type:"send_sms",template_id:…},{type:"wait",days:2},{type:"send_email",template_id:…},{type:"wait",days:5},{type:"send_direct_mail",template_id:…}]`,
      inputSchema: z.strictObject({
        name: z.string().min(1).max(255).describe("Workflow name shown in Spur"),
        description: z.string().max(1000).optional().describe("Optional note about the workflow's goal"),
        steps: z.array(stepInput).min(1).max(30).describe("Steps in run order: send_email / send_sms / send_direct_mail with a saved template_id, and wait steps (days, hours) between them")
      }),
      annotations: WRITE
    },
    async ({ name, description, steps }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const built = await Promise.all(
        steps.map(async (step, order) => {
          if (step.type === "wait") {
            if (!step.days && !step.hours) throw new Error(`Step ${order + 1}: a wait needs days or hours.`);
            return { type: "wait", step_order: order, config: { days: step.days, hours: step.hours } };
          }
          const extra =
            step.type === "send_email" ? { send_as_reply: step.send_as_reply ?? false } : step.type === "send_direct_mail" && step.return_address_id ? { return_address_id: step.return_address_id } : {};
          const config = await sendStepConfig(step.type, step.template_id, signal, extra).catch(error => {
            throw new Error(`Step ${order + 1} (${STEP_LABELS[step.type]}): ${(error as Error).message}`);
          });
          return { type: step.type, step_order: order, config };
        })
      );
      const created = await spur.data<Workflow>("POST", "/outreach/workflows", {
        body: { name, description: description ?? null, status: "draft", is_active: false, trigger_type: "manual", trigger_config: {}, steps: built },
        signal
      });
      const names = await templateNames(signal);
      return structuredResult(
        `${workflowText(created, names)}\n\nSaved as an inactive draft. When the user is ready, activate it with spur_set_workflow_active, then enroll owners with spur_enroll_owners_in_workflow.`,
        { workflow_id: created.id, steps: (created.steps || []).map(s => ({ id: s.id, type: s.step_type })) }
      );
    }
  );

  server.registerTool(
    "spur_set_workflow_step_template",
    {
      title: "Use template in workflow step",
      description: "Set which saved template a workflow's send step uses (send_email ← email template, send_sms ← SMS template, send_direct_mail ← postcard/letter template). Get step_ids from spur_get_workflow. If the workflow is active, enrolled owners get the new template from their next send.",
      inputSchema: z.strictObject({
        workflow_id: uuid("Workflow"),
        step_id: z.string().min(1).describe("step_id from spur_get_workflow"),
        template_id: uuid("Template")
      }),
      annotations: { ...WRITE, idempotentHint: true }
    },
    async ({ workflow_id, step_id, template_id }, ctx) => {
      const signal = ctx.mcpReq.signal;
      const w = await loadWorkflow(workflow_id, signal);
      const step = (w.steps || []).find(s => s.id === step_id);
      if (!step) return { ...textResult(`Step ${step_id} isn't in workflow "${w.name}". Call spur_get_workflow for its step_ids.`), isError: true };
      if (!(SEND_STEPS as readonly string[]).includes(step.step_type)) {
        return { ...textResult(`Step ${step_id} is a "${STEP_LABELS[step.step_type] || step.step_type}" step; only send steps use templates.`), isError: true };
      }
      const keep = { ...(step.config || {}) };
      for (const k of ["template_id", "template_name", "template_source", "mail_type", "postcard_size"]) delete keep[k];
      const config = await sendStepConfig(step.step_type as SendStep, template_id, signal, keep);
      const steps = (w.steps || []).map(s => stepPayload(s.id === step_id ? { ...s, config } : s));
      const updated = await spur.data<Workflow>("PUT", `/outreach/workflows/${encodeURIComponent(workflow_id)}`, {
        body: { name: w.name, description: w.description, status: w.status, is_active: w.is_active, trigger_type: w.trigger_type, trigger_config: w.trigger_config, steps },
        signal
      });
      const names = await templateNames(signal);
      return textResult(`Step now uses "${config.template_name}".\n\n${workflowText({ ...w, ...updated, steps: updated.steps || steps }, names)}`);
    }
  );

  server.registerTool(
    "spur_set_workflow_active",
    {
      title: "Activate or pause workflow",
      description: "Activate a workflow (enrolled owners start receiving its emails, texts and mail on schedule, which uses credits) or pause it. Activating requires every send step to have a template and the user's explicit approval.",
      inputSchema: z.strictObject({
        workflow_id: uuid("Workflow"),
        active: z.boolean().describe("true = activate (start sending), false = pause"),
        confirm: confirmField.optional().describe("Required (true) when activating, only after the user approved it")
      }),
      annotations: OUTWARD
    },
    async ({ workflow_id, active, confirm }, ctx) => {
      const signal = ctx.mcpReq.signal;
      if (active) {
        if (confirm !== true) return { ...textResult("Activating starts real outreach. Get the user's approval, then call again with confirm=true."), isError: true };
        const w = await loadWorkflow(workflow_id, signal);
        const missing = (w.steps || []).filter(s => (SEND_STEPS as readonly string[]).includes(s.step_type) && !s.config?.template_id);
        if (!(w.steps || []).length) return { ...textResult(`"${w.name}" has no steps.`), isError: true };
        if (missing.length) {
          return { ...textResult(`Can't activate "${w.name}": ${missing.length} send step(s) have no template (${missing.map(s => s.id).join(", ")}). Set them with spur_set_workflow_step_template.`), isError: true };
        }
      }
      const updated = await spur.data<Workflow>("PUT", `/outreach/workflows/${encodeURIComponent(workflow_id)}/toggle`, { body: { is_active: active }, signal });
      return textResult(active ? `Activated "${updated.name}". Enrolled owners will receive its steps on schedule.` : `Paused "${updated.name}". No further steps send until it's reactivated.`);
    }
  );

  server.registerTool(
    "spur_enroll_owners_in_workflow",
    {
      title: "Enroll owners in workflow",
      description: `Enroll owners in an outreach workflow. The workflow will start emailing/texting/mailing them on its schedule, which uses credits. Confirm the workflow name and owner count with the user first.`,
      inputSchema: z.strictObject({
        workflow_id: uuid("Workflow"),
        owner_ids: z.array(z.string()).min(1).max(500).describe("Owner ids to enroll (from spur_find_owners); owners without the needed contact details are skipped"),
        confirm: confirmField
      }),
      annotations: OUTWARD
    },
    async ({ workflow_id, owner_ids }, ctx) => {
      const result = await spur.data<{ enrolled?: number; skipped?: number; errors?: unknown[] }>(
        "POST",
        `/outreach/workflows/${encodeURIComponent(workflow_id)}/enroll-by-owners`,
        { body: { owner_ids }, signal: ctx.mcpReq.signal }
      );
      return textResult(
        `Enrolled ${result?.enrolled ?? owner_ids.length} owners in workflow ${workflow_id}${result?.skipped ? ` (${result.skipped} skipped: already enrolled or missing contact info)` : ""}.`
      );
    }
  );

  server.registerTool(
    "spur_send_sms",
    {
      title: "Send SMS",
      description: `Text an owner from the user's Spur number. Show the user the exact message and recipient and get approval before calling with confirm=true. Costs 1 SMS credit.`,
      inputSchema: z.strictObject({
        owner_id: uuid("Owner"),
        message: z.string().min(1).max(1600).describe("Exact SMS text the user approved"),
        confirm: confirmField
      }),
      annotations: OUTWARD
    },
    async ({ owner_id, message }, ctx) => {
      await spur.data("POST", "/sms/send", { body: { ownerId: owner_id, message }, signal: ctx.mcpReq.signal });
      return textResult(`Sent to owner ${owner_id}: "${message}"`);
    }
  );

  server.registerTool(
    "spur_list_sms_conversations",
    {
      title: "SMS inbox",
      description: "SMS conversations with owners, newest first, with unread counts and the last message. Good for triaging replies (hot leads, not interested, wrong number).",
      inputSchema: z.strictObject({
        unread_only: z.boolean().default(false).describe("true = only conversations with unread replies"),
        limit: z.number().int().min(1).max(100).default(25).describe("Maximum conversations to return")
      }),
      annotations: READ_ONLY
    },
    async ({ unread_only, limit }, ctx) => {
      const conversations = ((await spur.data<Conversation[]>("GET", "/sms/conversations", { signal: ctx.mcpReq.signal })) || []).filter(
        c => !unread_only || c.unreadCount > 0
      );
      if (!conversations.length) return textResult(unread_only ? "No unread replies." : "No SMS conversations yet.");
      const shown = conversations.slice(0, limit);
      const text = [
        `# ${conversations.length} conversations${unread_only ? " with unread replies" : ""}`,
        ...shown.map(c => {
          const last = c.lastMessage;
          const who = last?.direction === "inbound" ? "Them" : "You";
          return `- **${c.owner.full_name || c.owner.phone_numbers?.[0] || "Unknown"}** (owner_id: ${c.owner.id})${c.unreadCount ? ` — ${c.unreadCount} unread` : ""}\n  ${who}, ${dateTime(last?.sent_at)}: "${(last?.message || "").slice(0, 200)}"`;
        }),
        conversations.length > shown.length ? `\n${conversations.length - shown.length} more; raise limit to see them.` : ""
      ].join("\n");
      return textResult(text);
    }
  );

  server.registerTool(
    "spur_get_sms_conversation",
    {
      title: "SMS thread",
      description: "The full SMS thread with one owner, oldest first.",
      inputSchema: z.strictObject({ owner_id: uuid("Owner") }),
      annotations: READ_ONLY
    },
    async ({ owner_id }, ctx) => {
      const messages = (await spur.data<SmsMessage[]>("GET", `/sms/conversation/${encodeURIComponent(owner_id)}`, { signal: ctx.mcpReq.signal })) || [];
      if (!messages.length) return textResult("No messages with this owner yet.");
      const sorted = [...messages].sort((a, b) => new Date(a.sent_at || 0).getTime() - new Date(b.sent_at || 0).getTime());
      return textResult(
        [`# SMS thread with owner ${owner_id}`, ...sorted.map(m => `- ${m.direction === "inbound" ? "Them" : "You"} · ${dateTime(m.sent_at)}${m.status === "failed" ? " · FAILED" : ""}: ${m.message}`)].join("\n")
      );
    }
  );

  server.registerTool(
    "spur_get_outreach_report",
    {
      title: "Outreach report",
      description: "Outreach performance (sent, delivered, opened, replied, by channel) for all workflows or one, over an optional date range.",
      inputSchema: z.strictObject({
        workflow_id: z.string().optional().describe("Report on one workflow only; omit for all workflows"),
        date_from: z.string().optional().describe("ISO date, e.g. 2026-10-01"),
        date_to: z.string().optional().describe("ISO date")
      }),
      annotations: READ_ONLY
    },
    async ({ workflow_id, date_from, date_to }, ctx) => {
      const report = await spur.data<Record<string, unknown>>("GET", "/outreach/report", {
        query: { workflow_id, date_from, date_to },
        signal: ctx.mcpReq.signal
      });
      const summary = (report?.summary || report?.totals || report) as Record<string, unknown>;
      const flat = Object.entries(summary || {}).filter(([, v]) => typeof v === "number" || typeof v === "string");
      const text = flat.length
        ? `# Outreach report${workflow_id ? ` for workflow ${workflow_id}` : ""}\n${bullets(flat.map(([k, v]) => [k.replace(/_/g, " "), v]))}`
        : `# Outreach report\n\`\`\`json\n${JSON.stringify(report, null, 2).slice(0, 6000)}\n\`\`\``;
      return textResult(text);
    }
  );
}
