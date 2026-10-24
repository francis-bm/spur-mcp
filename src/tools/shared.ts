/**
 * Helpers shared by every tool module: result builders, formatting, and the per-request context.
 */
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Sealer } from "../auth/seal.js";
import { CHARACTER_LIMIT } from "../config.js";
import type { SpurClient } from "../spurApi.js";

export interface ToolContext {
  server: McpServer;
  spur: SpurClient;
  sealer: Sealer;
}

/** Hint sets reused across tools; clients use them to auto-approve reads and confirm writes */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Spends money or reaches real people (mail, SMS, skip tracing); clients should always confirm */
export const OUTWARD = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

/**
 * Required on every tool that spends money or contacts people. The model may only set it after
 * the user has explicitly approved this exact action in the conversation.
 */
export const confirmField = z
  .literal(true)
  .describe("Set to true ONLY after the user explicitly approved this exact action in the conversation. Never assume approval.");

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** Markdown for the model plus structured data for widgets and programmatic clients */
export function structuredResult(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

export function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export function date(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function dateTime(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Drops empty values so markdown bullet lists stay short */
export function bullets(entries: Array<[string, unknown]>): string {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && value !== "—")
    .map(([label, value]) => `- ${label}: ${value}`)
    .join("\n");
}

/**
 * Pages a list and stays under CHARACTER_LIMIT by returning fewer items, never by cutting text.
 * Returns the markdown and the slice actually rendered.
 */
export function paginate<T>(
  all: T[],
  { limit, offset }: { limit: number; offset: number },
  render: (items: T[]) => string
): { text: string; items: T[]; total: number; nextOffset?: number } {
  let items = all.slice(offset, offset + limit);
  const build = (slice: T[]) => {
    const next = offset + slice.length;
    const more = all.length > next;
    const footer = more ? `\n\nShowing ${offset + 1}–${next} of ${all.length}. More results: call again with offset=${next}.` : "";
    return { text: render(slice) + footer, more, next };
  };
  let out = build(items);
  while (items.length > 1 && out.text.length > CHARACTER_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    out = build(items);
  }
  return { text: out.text, items, total: all.length, ...(out.more ? { nextOffset: out.next } : {}) };
}

export const paginationFields = {
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum number of items to return"),
  offset: z.number().int().min(0).default(0).describe("Number of items to skip, for pagination")
};

export const uuid = (what: string) => z.string().min(1).max(64).describe(`${what} id (UUID from a Spur list/search tool)`);
