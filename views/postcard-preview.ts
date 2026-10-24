/**
 * Direct-mail preview widget: renders postcard front/back artwork or a letter page exactly as
 * authored (isolated, script-free), shows recipients and cost, and for campaign previews sends
 * only after an in-widget confirmation.
 */
import "./base.css";
import "./postcard-preview.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { checkClearZone, describeCheck, designToBleed, type ClearZoneSpec, type ZoneCheck } from "./clearZone.js";
import { askAssistant, connect, el, resultText, usd, type ToolResultPayload } from "./shared.js";

interface Payload {
  view?: string;
  mail_type?: "postcard" | "letter";
  mode?: "template" | "campaign";
  template?: { id: string; name: string; size: string; inches: [number, number]; is_default?: boolean };
  front_html?: string;
  back_html?: string;
  /** Letter page HTML */
  html?: string;
  letter?: { type: "top_first_page" | "insert_blank_page"; label: string };
  print?: { color: boolean; double_sided: boolean };
  merge_fields?: string[];
  /** Postcard back USPS clear zone (bleed inches) */
  clear_zone?: ClearZoneSpec;
  sample?: { label?: string; owner_id?: string; mailing_address?: string | null };
  recipients?: { requested: number; mailable: number; no_address: number; not_found: number };
  return_address?: { id: string; label: string };
  cost?: {
    recipients: number;
    included_remaining: number | null;
    billable: number;
    unit_price_usd: number | null;
    estimated_charge_usd: number | null;
    wallet_balance_usd: number | null;
    wallet_short: boolean;
  };
  confirmation_token?: string;
  expires_at?: string;
  /** Present on spur_send_postcards results */
  batch_id?: string | null;
  status?: string;
}

const root = document.getElementById("root") as HTMLElement;
let app: App;
let sent = false;
const resizers: Array<() => void> = [];

const BLEED_IN = 0.125;
const PX_PER_IN = 300;
/** Letters are authored in CSS inches (96 px/in): 8.5in × 11in */
const LETTER_W = 816;
const LETTER_H = 1056;
const ADDRESS_ZONE_PX = Math.round(3.15 * 96);

/** Latest clear-zone check for the rendered postcard; the back overlay and send button follow it */
let zoneCheck: ZoneCheck | undefined;
const zoneListeners: Array<() => void> = [];
const zoneBlocking = () => zoneCheck?.status === "overlap";

const noun = (payload: Payload) => (payload.mail_type === "letter" ? "letter" : "postcard");

/** Shadow-DOM fallback for hosts whose CSP blocks srcdoc frames; html/body rules are retargeted */
function renderInShadow(frame: HTMLElement, html: string, naturalWidth: number, naturalHeight: number) {
  frame.replaceChildren();
  const host = el("div");
  host.style.cssText = `position:absolute;top:0;left:0;width:${naturalWidth}px;height:${naturalHeight}px;transform-origin:0 0;`;
  const shadow = host.attachShadow({ mode: "closed" });
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script").forEach(s => s.remove());
  const styles = [...parsed.querySelectorAll("style")].map(s => (s.textContent || "").replace(/(^|[\s,{}])(html|body)(?=[\s,{.:#[])/g, "$1.pc-root"));
  const body = el("div", { className: "pc-root" });
  body.innerHTML = parsed.body.innerHTML;
  const style = document.createElement("style");
  style.textContent = `.pc-root{width:${naturalWidth}px;height:${naturalHeight}px;overflow:hidden;background:#fff;}${styles.join("\n")}`;
  shadow.append(style, body);
  frame.append(host);
  const fit = () => {
    const scale = frame.clientWidth / naturalWidth;
    host.style.transform = `scale(${scale})`;
    frame.style.height = `${naturalHeight * scale}px`;
  };
  fit();
  resizers.push(fit);
}

/** Clear-zone boxes and any overlapping content, positioned over the back in frame pixels */
function drawZones(layer: HTMLElement, spec: ClearZoneSpec, frame: HTMLElement, natural: () => [number, number]) {
  const [w, h] = natural();
  // Map through the canvas the check measured (the backend scales that, not the whole page)
  const canvas = zoneCheck?.canvas || { left: 0, top: 0, w, h };
  const map = designToBleed(canvas.w, canvas.h, spec.bleed_inches);
  const k = frame.clientWidth / w;
  const place = (node: HTMLElement, box: { x: number; y: number; w: number; h: number }) => {
    node.style.left = `${(canvas.left + (box.x - map.ox) / map.s) * k}px`;
    node.style.top = `${(canvas.top + (box.y - map.oy) / map.s) * k}px`;
    node.style.width = `${(box.w / map.s) * k}px`;
    node.style.height = `${(box.h / map.s) * k}px`;
    return node;
  };
  const conflicted = new Set(zoneCheck?.overlaps.map(o => o.zone.id));
  layer.replaceChildren(
    ...spec.zones.map(z =>
      place(el("div", { className: `pp-zone${conflicted.has(z.id) ? " conflict" : ""}`, text: z.label, attrs: { title: `USPS clear zone: ${z.label}` } }), z)
    ),
    ...(zoneCheck?.overlaps || []).map(o => place(el("div", { className: "pp-zone-hit", attrs: { title: `${o.zone.label}: ${o.what}` } }), o.box))
  );
}

function renderSide(label: string, html: string, inches: [number, number], clearZone?: ClearZoneSpec): HTMLElement {
  // Spur templates are authored at 300 px/in including bleed; measured size wins when available
  let naturalWidth = Math.round((inches[0] + BLEED_IN * 2) * PX_PER_IN);
  let naturalHeight = Math.round((inches[1] + BLEED_IN * 2) * PX_PER_IN);
  const frame = el("div", { className: "pp-frame", attrs: { role: "img", "aria-label": `${label} of postcard` } });
  frame.style.aspectRatio = `${inches[0] + BLEED_IN * 2} / ${inches[1] + BLEED_IN * 2}`;

  const iframe = el("iframe", { attrs: { sandbox: "allow-same-origin", title: `${label} of postcard`, loading: "eager", referrerpolicy: "no-referrer" } });
  iframe.srcdoc = html || "<p style='font:24px sans-serif;padding:40px'>Empty</p>";
  frame.append(iframe);
  const zoneLayer = clearZone ? el("div", { className: "pp-zone-layer", attrs: { "aria-hidden": "true" } }) : null;
  if (zoneLayer) frame.append(zoneLayer);
  const redrawZones = () => {
    if (zoneLayer && clearZone) drawZones(zoneLayer, clearZone, frame, () => [naturalWidth, naturalHeight]);
  };
  if (zoneLayer) zoneListeners.push(redrawZones);

  const fit = () => {
    const scale = frame.clientWidth / naturalWidth;
    iframe.style.width = `${naturalWidth}px`;
    iframe.style.height = `${naturalHeight}px`;
    iframe.style.transform = `scale(${scale})`;
    frame.style.aspectRatio = "";
    frame.style.height = `${naturalHeight * scale}px`;
    redrawZones();
  };
  let loaded = false;
  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) return;
    loaded = true;
    const w = doc.documentElement.scrollWidth;
    const h = doc.documentElement.scrollHeight;
    // Ignore implausible measurements (e.g. fluid templates that collapse to the iframe size)
    if (w > 200 && h > 120 && Math.abs(w / h - naturalWidth / naturalHeight) < 0.35) {
      naturalWidth = w;
      naturalHeight = h;
    }
    fit();
  });
  fit();
  resizers.push(fit);
  setTimeout(() => {
    if (loaded) return;
    renderInShadow(frame, html, naturalWidth, naturalHeight);
    if (zoneLayer) {
      frame.append(zoneLayer);
      redrawZones();
    }
  }, 1500);

  return el("div", { className: "pp-side" }, [
    el("div", { className: "pp-side-label", text: label }),
    frame,
    // Blank space on the back is intentional; say so instead of letting it look broken
    label === "Back"
      ? el("div", {
          className: "pp-note",
          text: clearZone
            ? "Dashed boxes are the USPS clear zone: Spur prints postage, the address block and the barcode there, covering anything underneath. Keep text and images out of them."
            : "Spur prints the recipient address and postage on the back."
        })
      : null
  ]);
}

/**
 * One letter page at true scale, with the address band (top_first_page) drawn over it and a page
 * line wherever the content spills past 11in. Reports the measured page count.
 */
function renderLetter(payload: Payload, onPages: (pages: number) => void): HTMLElement {
  const html = payload.html || "";
  const topFirst = payload.letter?.type !== "insert_blank_page";
  let naturalHeight = LETTER_H;
  const frame = el("div", { className: "pp-frame", attrs: { role: "img", "aria-label": "Letter page" } });
  const iframe = el("iframe", { attrs: { sandbox: "allow-same-origin", title: "Letter page", loading: "eager", referrerpolicy: "no-referrer" } });
  iframe.srcdoc = html || "<p style='font:16px sans-serif;padding:40px'>Empty</p>";
  const overlay = topFirst
    ? el("div", { className: "pp-address-zone", text: "Address area: your return address and the recipient's address print here and show through the envelope window" })
    : null;
  const pageLines = el("div");
  frame.append(iframe, pageLines);
  if (overlay) frame.append(overlay);

  const drawPageLines = (scale: number) => {
    const lines: HTMLElement[] = [];
    for (let y = LETTER_H; y < naturalHeight - 4; y += LETTER_H) {
      const line = el("div", { className: "pp-page-break", text: "Page break: content past here prints on another page" });
      line.style.top = `${y * scale}px`;
      lines.push(line);
    }
    pageLines.replaceChildren(...lines);
  };
  const fit = () => {
    const scale = frame.clientWidth / LETTER_W;
    iframe.style.width = `${LETTER_W}px`;
    iframe.style.height = `${naturalHeight}px`;
    iframe.style.transform = `scale(${scale})`;
    frame.style.height = `${naturalHeight * scale}px`;
    if (overlay) overlay.style.height = `${ADDRESS_ZONE_PX * scale}px`;
    drawPageLines(scale);
  };
  let loaded = false;
  iframe.addEventListener("load", () => {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) return;
    loaded = true;
    naturalHeight = Math.max(LETTER_H, doc.documentElement.scrollHeight);
    onPages(Math.max(1, Math.ceil((naturalHeight - 4) / LETTER_H)));
    fit();
  });
  fit();
  resizers.push(fit);
  setTimeout(() => {
    if (loaded) return;
    renderInShadow(frame, html, LETTER_W, naturalHeight);
    frame.append(pageLines);
    if (overlay) frame.append(overlay);
  }, 1500);

  const pages: HTMLElement[] = [];
  if (!topFirst) {
    pages.push(
      el("div", { className: "pp-side" }, [
        el("div", { className: "pp-side-label", text: "Page 1 · added by Spur" }),
        el("div", { className: "pp-address-page", text: "Address page: Spur prints the recipient address, your return address and the USPS barcode on this page." })
      ])
    );
  }
  pages.push(el("div", { className: "pp-side" }, [el("div", { className: "pp-side-label", text: topFirst ? "Page 1" : "Page 2 · your letter" }), frame]));
  return el("div", { className: "pp-letter" }, pages);
}

function stat(label: string, value: string, extra?: HTMLElement | null) {
  return el("div", { className: "pp-stat" }, [el("div", { className: "k", text: label }), el("div", { className: "v", text: value }), extra || null]);
}

function costLine(cost: NonNullable<Payload["cost"]>): string {
  if (cost.estimated_charge_usd === null) return "See Spur billing";
  if (cost.estimated_charge_usd === 0) return "$0 (covered by plan)";
  return `${usd(cost.estimated_charge_usd, 2)} (${cost.billable} × ${usd(cost.unit_price_usd, 2)})`;
}

/** Draws the send controls; returns a refresh for when the clear-zone check lands */
function renderSendFlow(container: HTMLElement, payload: Payload): () => void {
  const cost = payload.cost;
  const count = payload.recipients?.mailable ?? 0;
  const expires = payload.expires_at ? new Date(payload.expires_at).getTime() : 0;
  const expired = () => !expires || Date.now() > expires;
  const priceText = cost && cost.estimated_charge_usd ? ` · ~${usd(cost.estimated_charge_usd, 2)}` : "";

  const showIdle = () => {
    if (sent) return;
    if (zoneBlocking()) {
      const blocked = el("button", { className: "primary", text: "Send blocked: fix the clear zone" });
      blocked.disabled = true;
      container.replaceChildren(
        el("div", { className: "pp-cta" }, [
          el("span", { className: "pp-warn", text: "Content on the back is inside the USPS clear zone and would be covered when printed." }),
          el("button", {
            text: "Fix design",
            onClick: () => void askAssistant(app, `Fix the back of the "${payload.template?.name}" postcard so nothing is inside the USPS clear zone, then show me the mailing preview again.`)
          }),
          blocked
        ])
      );
      return;
    }
    if (expired()) {
      container.replaceChildren(
        el("div", { className: "pp-cta" }, [
          el("span", { className: "pp-warn", text: "This preview expired." }),
          el("button", { text: "Refresh preview", onClick: () => void askAssistant(app, `Refresh the ${noun(payload)} mailing preview with the same template and recipients.`) })
        ])
      );
      return;
    }
    const send = el("button", { className: "primary", text: `Send ${count} ${noun(payload)}${count === 1 ? "" : "s"}${priceText}` });
    send.disabled = !payload.confirmation_token || !!cost?.wallet_short;
    send.addEventListener("click", showConfirm);
    container.replaceChildren(
      el("div", { className: "pp-cta" }, [
        cost?.wallet_short ? el("span", { className: "pp-warn", text: "Wallet balance is too low." }) : null,
        cost?.wallet_short
          ? el("button", {
              className: "primary",
              text: "Top up wallet",
              onClick: () => void askAssistant(app, `Top up my Spur wallet so I can send these ${count} ${noun(payload)}s${cost?.estimated_charge_usd ? ` (about ${usd(cost.estimated_charge_usd, 2)}; I have ${usd(cost.wallet_balance_usd, 2)})` : ""}.`)
            })
          : null,
        el("button", { text: "Change design", onClick: () => void askAssistant(app, `I want to change the design of the "${payload.template?.name}" ${noun(payload)} before mailing.`) }),
        send
      ])
    );
  };

  const showConfirm = () => {
    const yes = el("button", { className: "danger", text: "Yes, mail them" });
    const no = el("button", { text: "Cancel", onClick: showIdle });
    yes.addEventListener("click", () => void doSend(yes, no));
    container.replaceChildren(
      el("div", { className: "pp-confirm", attrs: { role: "alertdialog", "aria-label": "Confirm mailing" } }, [
        el("p", {
          text: `Mail ${count} "${payload.template?.name}" ${noun(payload)}s to real people? This can't be undone${cost?.estimated_charge_usd ? ` and charges about ${usd(cost.estimated_charge_usd, 2)}` : ""}.`
        }),
        el("div", { className: "pp-cta" }, [no, yes])
      ])
    );
    yes.focus();
  };

  const doSend = async (yes: HTMLButtonElement, no: HTMLButtonElement) => {
    yes.disabled = true;
    no.disabled = true;
    yes.textContent = "Sending…";
    try {
      const result = (await app.callServerTool({
        name: `spur_send_${noun(payload)}s`,
        arguments: { confirmation_token: payload.confirmation_token, confirm: true }
      })) as ToolResultPayload;
      if (result.isError) throw new Error(resultText(result) || "Sending failed");
      sent = true;
      container.replaceChildren(el("div", { className: "pp-done", attrs: { role: "status" }, text: `✓ ${resultText(result)}` }));
      await app
        .updateModelContext({ content: [{ type: "text", text: `User approved and sent the ${noun(payload)}s from the preview widget: ${resultText(result)}` }] })
        .catch(() => undefined);
    } catch (error) {
      container.replaceChildren(
        el("div", { className: "pp-confirm" }, [
          el("p", { className: "pp-warn", text: (error as Error).message }),
          el("div", { className: "pp-cta" }, [el("button", { text: "Back", onClick: showIdle })])
        ])
      );
    }
  };

  showIdle();
  // Flip to the expired state on time even if nobody interacts
  if (expires > Date.now()) setTimeout(showIdle, Math.min(expires - Date.now() + 500, 2 ** 31 - 1));
  return showIdle;
}

let renderId = 0;

function render(payload: Payload) {
  resizers.length = 0;
  zoneListeners.length = 0;
  zoneCheck = undefined;
  const thisRender = ++renderId;
  const template = payload.template;
  if (!template) {
    root.replaceChildren(el("div", { className: "empty", text: "Nothing to preview." }));
    return;
  }
  const isLetter = payload.mail_type === "letter";
  let layout: "both" | "front" | "back" = window.innerWidth < 560 ? "front" : "both";
  const sides = el("div", { className: "pp-sides" });
  const drawSides = () => {
    resizers.length = 0;
    // Back overlays re-register on redraw; the send flow and report stay registered
    zoneListeners.splice(0, zoneListeners.length, ...persistentZoneListeners);
    sides.className = `pp-sides${layout === "both" ? "" : " single"}`;
    sides.replaceChildren(
      ...(layout !== "back" ? [renderSide("Front", payload.front_html || "", template.inches)] : []),
      ...(layout !== "front" ? [renderSide("Back", payload.back_html || "", template.inches, payload.clear_zone)] : [])
    );
  };
  const tabs = el("div", { className: "pp-tabs", attrs: { role: "group", "aria-label": "Postcard side" } });
  const tabButtons = (["both", "front", "back"] as const).map(value => {
    const button = el("button", { text: value === "both" ? "Both" : value[0].toUpperCase() + value.slice(1), attrs: { "aria-pressed": String(layout === value) } });
    button.addEventListener("click", () => {
      layout = value;
      tabButtons.forEach(b => b.setAttribute("aria-pressed", String(b === button)));
      drawSides();
    });
    return button;
  });
  tabs.append(...tabButtons);

  const panel = el("div", { className: "pp-panel" });
  const pagesValue = el("div", { className: "v", text: "1" });
  const pagesWarn = el("div", { className: "pp-warn" });
  if (isLetter) {
    panel.append(stat("Letter type", `${payload.letter?.label || "Top First Page"}${template.is_default ? " · Spur template" : ""}`));
    panel.append(el("div", { className: "pp-stat" }, [el("div", { className: "k", text: "Letter pages" }), pagesValue, pagesWarn]));
    if (payload.print) panel.append(stat("Printing", `${payload.print.color ? "Color" : "Black & white"}, ${payload.print.double_sided ? "double-sided" : "single-sided"}`));
  } else {
    panel.append(stat("Size", `${template.size}${template.is_default ? " · Spur default" : ""}`));
  }
  const zoneValue = el("div", { className: "v", text: "Checking…" });
  const zoneReport = el("div", { className: "pp-zone-report", attrs: { role: "status" } });
  if (!isLetter && payload.clear_zone) {
    panel.append(el("div", { className: "pp-stat", attrs: { style: "grid-column: 1 / -1" } }, [el("div", { className: "k", text: "USPS clear zone (back)" }), zoneValue, zoneReport]));
  }
  panel.append(stat("Personalized for", payload.sample?.label || "Sample data"));
  if (payload.mode === "campaign" && payload.recipients) {
    const r = payload.recipients;
    const skipped = r.no_address + r.not_found;
    panel.append(stat("Recipients", `${r.mailable} of ${r.requested}`, skipped ? el("div", { className: "pp-warn", text: `${skipped} skipped (no address)` }) : null));
  }
  if (payload.cost) {
    panel.append(stat("Estimated cost", costLine(payload.cost)));
    if (payload.cost.wallet_balance_usd !== null) panel.append(stat("Wallet", usd(payload.cost.wallet_balance_usd, 2)));
  }
  if (payload.return_address) panel.append(stat("Return address", payload.return_address.label));
  if (payload.merge_fields?.length) {
    panel.append(
      el("div", { className: "pp-stat", attrs: { style: "grid-column: 1 / -1" } }, [
        el("div", { className: "k", text: "Merge fields" }),
        el("div", { className: "pp-fields" }, payload.merge_fields.map(f => el("span", { className: "chip", text: `{{${f}}}` })))
      ])
    );
  }

  const showZoneReport = () => {
    if (!zoneCheck) return;
    if (zoneCheck.status === "unavailable") {
      zoneValue.textContent = "Not checked in this view: keep the dashed zones on the back empty";
      return;
    }
    if (zoneCheck.status === "clear") {
      zoneValue.textContent = "✓ Clear: nothing on the back sits in the clear zone";
      zoneReport.replaceChildren();
      return;
    }
    zoneValue.textContent = `⚠ ${zoneCheck.overlaps.length} item${zoneCheck.overlaps.length === 1 ? "" : "s"} inside the clear zone`;
    const children: HTMLElement[] = [
      el(
        "ul",
        {},
        zoneCheck.overlaps.map(o =>
          el("li", { text: `${o.zone.label}: ${o.what}` })
        )
      ),
      el("div", { className: "pp-warn", text: "Spur covers these with white when printing, so they'd be cut from the card. Mailing is blocked until they're moved." }),
    ];
    if (payload.mode !== "campaign") {
      children.push(
        el("div", { className: "pp-cta" }, [
          el("button", { text: "Fix design", onClick: () => void askAssistant(app, `Fix the back of the "${template.name}" postcard so nothing is inside the USPS clear zone.`) })
        ])
      );
    }
    zoneReport.replaceChildren(...children);
  };
  const persistentZoneListeners: Array<() => void> = [showZoneReport];

  const footer = el("div");
  if (payload.mode === "campaign") {
    persistentZoneListeners.push(renderSendFlow(footer, payload));
  } else {
    footer.append(
      el("div", { className: "pp-cta" }, [
        template.is_default
          ? el("button", { text: "Make editable copy", onClick: () => void askAssistant(app, `Make an editable copy of the "${template.name}" ${noun(payload)} template (template_id ${template.id}).`) })
          : null,
        el("button", {
          className: "primary",
          text: `Mail this ${noun(payload)}`,
          onClick: () => void askAssistant(app, `I want to mail the "${template.name}" ${noun(payload)} (template_id ${template.id}). Help me pick recipients and show me the mailing preview.`)
        })
      ])
    );
  }

  const onPages = (pages: number) => {
    pagesValue.textContent = String(pages);
    pagesWarn.textContent = pages > 1 ? `Runs onto ${pages} pages. Shorten it to fit one page before mailing.` : "";
  };
  root.replaceChildren(
    el("div", { className: "pp" }, [
      el("div", { className: "pp-head" }, [el("div", { className: "pp-title", text: template.name }), isLetter ? null : tabs]),
      isLetter ? renderLetter(payload, onPages) : sides,
      panel,
      footer
    ])
  );
  if (!isLetter) drawSides();

  if (!isLetter && payload.clear_zone && payload.back_html) {
    const spec = payload.clear_zone;
    const guess: [number, number] = [Math.round(spec.bleed_inches[0] * PX_PER_IN), Math.round(spec.bleed_inches[1] * PX_PER_IN)];
    void checkClearZone(payload.back_html, spec, guess).then(check => {
      if (thisRender !== renderId) return;
      zoneCheck = check;
      zoneListeners.forEach(listener => listener());
      const note = describeCheck(check, template.name, spec);
      if (note) void app?.updateModelContext({ content: [{ type: "text", text: note }] }).catch(() => undefined);
    });
  }
}

new ResizeObserver(() => resizers.forEach(fit => fit())).observe(root);

connect("spur-postcard-preview", (result, connected) => {
  app = connected;
  if (result.isError) {
    root.replaceChildren(el("div", { className: "empty", text: resultText(result) || "Something went wrong." }));
    return;
  }
  const payload = (result.structuredContent || {}) as Payload;
  // spur_send_postcards results (from the model) reuse this widget; show the outcome
  if (payload.view !== "postcard-preview") {
    if (payload.batch_id !== undefined || payload.status) {
      sent = true;
      root.replaceChildren(el("div", { className: "pp" }, [el("div", { className: "pp-done", text: `✓ ${resultText(result)}` })]));
    }
    return;
  }
  // Artwork with images inlined (server-side) so the widget CSP doesn't block them
  const artwork = result._meta?.["spur/postcard_artwork"] as Pick<Payload, "front_html" | "back_html" | "html"> | undefined;
  render(artwork ? { ...payload, ...artwork } : payload);
})
  .then(connected => {
    app = connected;
  })
  .catch(error => {
    root.replaceChildren(el("div", { className: "empty", text: `Could not connect to the assistant: ${(error as Error).message}` }));
  });
