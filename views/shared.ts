/**
 * Shared bootstrapping for Spur widgets: connects to the host (Claude or ChatGPT) over MCP Apps,
 * follows the host's theme, and gives views small DOM helpers.
 */
import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps";

export interface SpurWindowConfig {
  tileUrl: string;
  tileAttribution: string;
  appUrl: string;
}

declare global {
  interface Window {
    __SPUR__?: SpurWindowConfig;
  }
}

export const spurConfig: SpurWindowConfig = window.__SPUR__ || {
  tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  appUrl: ""
};

export interface ToolResultPayload {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

function applyContext(context: McpUiHostContext | undefined) {
  if (!context) return;
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

/** Connects to the host and calls `onResult` with every tool result for this widget */
export async function connect(name: string, onResult: (result: ToolResultPayload, app: App) => void): Promise<App> {
  const app = new App({ name, version: "1.0.0" }, {}, { autoResize: true });
  // Results can arrive while connect() is still settling, so hand the instance over with each one
  app.ontoolresult = params => onResult(params as ToolResultPayload, app);
  app.onhostcontextchanged = params => applyContext(params as McpUiHostContext);
  await app.connect();
  applyContext(app.getHostContext());
  return app;
}

/** Text of a tool result's first text block (for errors and confirmations) */
export function resultText(result: ToolResultPayload | undefined): string {
  return result?.content?.find(c => c.type === "text")?.text || "";
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string>; onClick?: (event: MouseEvent) => void } = {},
  children: Array<Node | string | null | undefined | false> = []
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs || {})) node.setAttribute(key, value);
  if (props.onClick) node.addEventListener("click", props.onClick as EventListener);
  for (const child of children) if (child) node.append(child);
  return node;
}

export const usd = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Asks the assistant to do something on the user's behalf, as if they typed it */
export function askAssistant(app: App, text: string) {
  return app.sendMessage({ role: "user", content: [{ type: "text", text }] }).catch(() => undefined);
}
