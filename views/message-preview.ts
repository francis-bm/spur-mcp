/**
 * Email and SMS preview widget: renders an email as it lands in an inbox (desktop and mobile width,
 * isolated and script-free, plus its plain-text part) or an SMS as a phone bubble with its segment
 * count, and lists the merge fields and design checks the tool reported.
 */
import "./base.css";
import "./message-preview.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { askAssistant, connect, el, resultText } from "./shared.js";

interface Payload {
  view?: string;
  channel?: "email" | "sms";
  template?: { id?: string; name: string; saved: boolean };
  subject?: string;
  snippet?: string;
  from?: { name: string; email: string } | null;
  text_body?: string;
  /** SMS */
  body?: string;
  fallback_body?: string | null;
  stats?: { characters: number; encoding: string; segments: number; per_segment: number };
  merge_fields?: string[];
  unresolved_fields?: string[];
  warnings?: string[];
  sample?: { label?: string; owner_id?: string | null };
  /** Rendered email HTML, from `_meta` */
  html?: string;
}

const root = document.getElementById("root") as HTMLElement;
let app: App;
const resizers: Array<() => void> = [];

const DESKTOP_W = 680;
const MOBILE_W = 375;

/** Shadow-DOM fallback for hosts whose CSP blocks srcdoc frames; html/body rules are retargeted */
function renderInShadow(frame: HTMLElement, html: string, width: number) {
  frame.replaceChildren();
  const host = el("div");
  host.style.cssText = `position:absolute;top:0;left:0;width:${width}px;transform-origin:0 0;`;
  const shadow = host.attachShadow({ mode: "closed" });
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach(s => s.remove());
  const styles = [...parsed.querySelectorAll("style")].map(s => (s.textContent || "").replace(/(^|[\s,{}])(html|body)(?=[\s,{.:#[])/g, "$1.mp-root"));
  const body = el("div", { className: "mp-root" });
  body.innerHTML = parsed.body.innerHTML;
  const bodyStyle = parsed.body.getAttribute("style");
  if (bodyStyle) body.setAttribute("style", bodyStyle);
  const style = document.createElement("style");
  style.textContent = `.mp-root{width:${width}px;background:#fff;}${styles.join("\n")}`;
  shadow.append(style, body);
  frame.append(host);
  const fit = () => {
    const scale = Math.min(1, frame.parentElement!.clientWidth / width);
    host.style.transform = `scale(${scale})`;
    frame.style.width = `${width * scale}px`;
    frame.style.height = `${host.scrollHeight * scale}px`;
  };
  fit();
  resizers.push(fit);
}

/** The email body at a fixed client width, scaled down when the widget is narrower; links are inert */
function renderEmailFrame(html: string, width: number): HTMLElement {
  const canvas = el("div", { className: `mp-canvas${width === MOBILE_W ? " mp-mobile" : ""}` });
  const frame = el("div", { className: "mp-frame", attrs: { role: "img", "aria-label": "Email body" } });
  const iframe = el("iframe", { attrs: { sandbox: "allow-same-origin", title: "Email body", loading: "eager", referrerpolicy: "no-referrer" } });
  iframe.srcdoc = html || "<p style='font:15px sans-serif;padding:24px;color:#6b7280'>Plain-text email (no HTML). See the Plain text tab.</p>";
  frame.append(iframe);
  canvas.append(frame);

  let contentHeight = 480;
  const fit = () => {
    const available = canvas.clientWidth - (width === MOBILE_W ? 12 : 0);
    const scale = Math.min(1, available / width);
    iframe.style.width = `${width}px`;
    iframe.style.height = `${contentHeight}px`;
    iframe.style.transform = `scale(${scale})`;
    frame.style.width = `${width * scale}px`;
    frame.style.height = `${contentHeight * scale}px`;
  };
  let loaded = false;
  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc?.documentElement) return;
    loaded = true;
    contentHeight = Math.max(200, doc.documentElement.scrollHeight);
    fit();
  });
  fit();
  resizers.push(fit);
  setTimeout(() => {
    if (!loaded && html) renderInShadow(frame, html, width);
  }, 1500);
  return canvas;
}

function stat(label: string, value: string, wide = false) {
  return el("div", { className: `mp-stat${wide ? " mp-wide" : ""}` }, [el("div", { className: "k", text: label }), el("div", { className: "v", text: value })]);
}

function detailsPanel(payload: Payload): HTMLElement {
  const panel = el("div", { className: "mp-panel" });
  panel.append(stat("Personalized for", payload.sample?.label || "Sample data"));
  if (payload.channel === "sms" && payload.stats) {
    const s = payload.stats;
    panel.append(stat("Length", `${s.characters} chars · ${s.segments} segment${s.segments === 1 ? "" : "s"}`));
    panel.append(stat("Encoding", s.encoding));
  }
  if (payload.merge_fields?.length) {
    const missing = new Set(payload.unresolved_fields || []);
    panel.append(
      el("div", { className: "mp-stat mp-wide" }, [
        el("div", { className: "k", text: "Merge fields" }),
        el("div", { className: "mp-fields" }, payload.merge_fields.map(f => el("span", { className: `chip${missing.has(f) ? " missing" : ""}`, text: `{{${f}}}` })))
      ])
    );
  }
  const warnings = payload.warnings || [];
  panel.append(
    el("div", { className: "mp-stat mp-wide" }, [
      el("div", { className: "k", text: "Checks" }),
      warnings.length ? el("ul", { className: "mp-checks" }, warnings.map(w => el("li", { text: w }))) : el("div", { className: "mp-ok", text: "✓ No issues found" })
    ])
  );
  return panel;
}

function actions(payload: Payload): HTMLElement {
  const t = payload.template;
  const kind = payload.channel === "sms" ? "SMS" : "email";
  const ref = t?.id ? `"${t.name}" ${kind} template (template_id ${t.id})` : `draft ${kind}`;
  return el("div", { className: "mp-cta" }, [
    el("button", { text: "Change design", onClick: () => void askAssistant(app, `I want to change the ${ref}.`) }),
    t?.saved && payload.channel === "email"
      ? el("button", { text: "Send me a test", onClick: () => void askAssistant(app, `Send me a test of the ${ref}.`) })
      : null,
    t?.saved
      ? el("button", {
          className: "primary",
          text: "Use in a workflow",
          onClick: () => void askAssistant(app, `I want to use the ${ref} in an outreach workflow. Show my workflows and help me add it.`)
        })
      : el("button", { className: "primary", text: "Save as template", onClick: () => void askAssistant(app, `Save this ${kind} as a template.`) })
  ]);
}

function renderEmail(payload: Payload): HTMLElement[] {
  let mode: "desktop" | "mobile" | "text" = window.innerWidth < 480 ? "mobile" : "desktop";
  const body = el("div");
  const draw = () => {
    resizers.length = 0;
    body.replaceChildren(
      mode === "text"
        ? el("pre", { className: "mp-text", text: payload.text_body || "(empty)" })
        : renderEmailFrame(payload.html || "", mode === "mobile" ? MOBILE_W : DESKTOP_W)
    );
  };
  const tabs = el("div", { className: "mp-tabs", attrs: { role: "group", "aria-label": "Preview mode" } });
  const buttons = (["desktop", "mobile", "text"] as const).map(value => {
    const button = el("button", { text: value === "text" ? "Plain text" : value[0].toUpperCase() + value.slice(1), attrs: { "aria-pressed": String(mode === value) } });
    button.addEventListener("click", () => {
      mode = value;
      buttons.forEach(b => b.setAttribute("aria-pressed", String(b === button)));
      draw();
    });
    return button;
  });
  tabs.append(...buttons);

  const from = payload.from ? `${payload.from.name} <${payload.from.email}>` : "No email sender set up yet";
  const mail = el("div", { className: "mp-mail" }, [
    el("div", { className: "mp-envelope" }, [
      el("div", { className: "mp-subject", text: payload.subject || "(no subject)" }),
      el("div", { className: "mp-meta", text: `From ${from} · To ${payload.sample?.label || "Sample owner"}` }),
      payload.snippet ? el("div", { className: "mp-snippet", text: payload.snippet }) : null
    ]),
    body
  ]);
  draw();
  return [head(payload, tabs), mail];
}

function renderSms(payload: Payload): HTMLElement[] {
  const phone = el("div", { className: "mp-phone", attrs: { role: "img", "aria-label": "Text message preview" } }, [
    el("div", { className: "mp-phone-label", text: `To ${payload.sample?.label || "Sample owner"}` }),
    el("div", { className: "mp-bubble", text: payload.body || "" }),
    payload.fallback_body ? el("div", { className: "mp-phone-label", text: "Sent instead if links are blocked" }) : null,
    payload.fallback_body ? el("div", { className: "mp-bubble alt", text: payload.fallback_body }) : null
  ]);
  return [head(payload), phone];
}

function head(payload: Payload, tabs?: HTMLElement): HTMLElement {
  const t = payload.template;
  return el("div", { className: "mp-head" }, [
    el("div", { className: "mp-title" }, [t?.name || "Preview", el("span", { className: "chip", text: t?.saved ? "Saved" : "Draft, not saved" })]),
    tabs || null
  ]);
}

function render(payload: Payload) {
  resizers.length = 0;
  const parts = payload.channel === "sms" ? renderSms(payload) : renderEmail(payload);
  root.replaceChildren(el("div", { className: "mp" }, [...parts, detailsPanel(payload), actions(payload)]));
}

new ResizeObserver(() => resizers.forEach(fit => fit())).observe(root);

connect("spur-message-preview", (result, connected) => {
  app = connected;
  if (result.isError) {
    root.replaceChildren(el("div", { className: "empty", text: resultText(result) || "Something went wrong." }));
    return;
  }
  const payload = (result.structuredContent || {}) as Payload;
  if (payload.view !== "message-preview") return;
  const meta = result._meta?.["spur/message_html"] as { html?: string } | undefined;
  render(meta ? { ...payload, html: meta.html } : payload);
})
  .then(connected => {
    app = connected;
  })
  .catch(error => {
    root.replaceChildren(el("div", { className: "empty", text: `Could not connect to the assistant: ${(error as Error).message}` }));
  });
