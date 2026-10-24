/**
 * Billing widget: wallet balance with one-click top-ups, plan cards with Upgrade buttons, and the
 * Stripe checkout / portal hand-off. Payment always happens on Stripe's page, opened through the host.
 */
import "./base.css";
import "./billing.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { connect, el, resultText, usd, type ToolResultPayload } from "./shared.js";

type Interval = "monthly" | "annual";

interface Plan {
  id: string;
  name: string;
  tier: number;
  monthly_usd: number;
  annual_usd: number;
  annual_monthly_usd: number;
  highlights: string[];
  current: boolean;
}

interface Options {
  view: "options";
  wallet_balance_usd: number | null;
  min_top_up_usd: number;
  top_up_presets_usd: number[];
  auto_recharge: { enabled: boolean; amount_usd: number | null; threshold_usd: number | null; card_on_file: boolean };
  current_plan: { id: string; interval: Interval | null; status: string | null; renews_on: string | null; cancel_at_period_end: boolean };
  has_active_subscription: boolean;
  has_billing_portal: boolean;
  stripe_enabled: boolean;
  plans: Plan[];
}

interface Checkout {
  view: "checkout";
  purpose: "top_up" | "subscription";
  label: string;
  checkout_url: string;
  session_id: string;
}

type Payload =
  | Options
  | Checkout
  | { view: "payment_status"; paid: boolean; message: string; session_id: string; options: Options }
  | { view: "confirm_plan"; message: string; plan_id: string; plan_name: string; billing_interval: Interval; price: string }
  | { view: "link"; message: string; label: string; url: string }
  | { view: "notice"; message: string; tone?: "good" };

const root = document.getElementById("root") as HTMLElement;
let app: App | undefined;
let interval: Interval = "monthly";

const tell = (text: string) => void app?.updateModelContext({ content: [{ type: "text", text }] }).catch(() => undefined);

async function call(name: string, args: Record<string, unknown>): Promise<Payload> {
  if (!app) throw new Error("Not connected yet");
  const result = (await app.callServerTool({ name, arguments: args })) as ToolResultPayload;
  if (result.isError) throw new Error(resultText(result) || "Spur could not complete that.");
  return result.structuredContent as unknown as Payload;
}

/** Opens a Stripe page in the user's browser; the URL stays visible in case the host blocks it */
function open(url: string) {
  void app?.openLink({ url }).catch(() => undefined);
}

function busy<T>(button: HTMLButtonElement, label: string, run: () => Promise<T>) {
  const before = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return run()
    .catch(error => showError((error as Error).message))
    .finally(() => {
      button.disabled = false;
      button.textContent = before;
    });
}

function showError(message: string) {
  const old = document.querySelector(".toast");
  old?.remove();
  const toast = el("div", { className: "toast error", attrs: { role: "alert" }, text: message });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 6000);
}

function header(title: string, back?: Options) {
  return el("div", { className: "bl-head" }, [
    el("span", { className: "bl-title", text: title }),
    back ? el("button", { className: "link", text: "← Billing", onClick: () => render(back) }) : null
  ]);
}

// ---------------------------------------------------------------- main view

function renderOptions(o: Options) {
  if (o.current_plan.interval) interval = o.current_plan.interval;
  const disabled = !o.stripe_enabled;

  // Wallet
  const custom = el("input", { className: "bl-amount", attrs: { type: "number", min: String(o.min_top_up_usd), step: "5", placeholder: "Other", "aria-label": "Custom amount in dollars" } });
  const topUp = (amount: number, button: HTMLButtonElement) =>
    busy(button, "Opening Stripe…", async () => {
      if (!Number.isFinite(amount) || amount < o.min_top_up_usd) throw new Error(`The minimum top-up is ${usd(o.min_top_up_usd)}.`);
      const checkout = (await call("spur_top_up_wallet", { amount_usd: amount })) as Checkout;
      open(checkout.checkout_url);
      tell(`User started a ${usd(amount)} wallet top-up from the billing widget (session_id ${checkout.session_id}).`);
      renderCheckout(checkout, o);
    });
  const presets = o.top_up_presets_usd.map(amount => {
    const b = el("button", { className: "bl-preset", text: usd(amount) });
    b.disabled = disabled;
    b.addEventListener("click", () => void topUp(amount, b));
    return b;
  });
  const customGo = el("button", { className: "primary", text: "Add funds" });
  customGo.disabled = disabled;
  customGo.addEventListener("click", () => void topUp(Number(custom.value), customGo));
  custom.addEventListener("keydown", e => e.key === "Enter" && customGo.click());

  const ar = o.auto_recharge;
  const wallet = el("section", { className: "bl-card" }, [
    el("div", { className: "bl-row" }, [
      el("div", {}, [el("div", { className: "muted", text: "Wallet balance" }), el("div", { className: "bl-balance", text: usd(o.wallet_balance_usd, 2) })]),
      el("span", { className: "chip", text: ar.enabled ? `Auto-recharge ${usd(ar.amount_usd)} below ${usd(ar.threshold_usd)}` : "Auto-recharge off" })
    ]),
    el("div", { className: "bl-presets" }, [...presets, custom, customGo]),
    autoRechargeControl(o)
  ]);

  // Plans
  const toggle = el("div", { className: "bl-toggle", attrs: { role: "group", "aria-label": "Billing interval" } }, (["monthly", "annual"] as Interval[]).map(i => {
    const b = el("button", { text: i === "monthly" ? "Monthly" : "Annual (save ~20%)", attrs: { "aria-pressed": String(i === interval) } });
    b.addEventListener("click", () => {
      interval = i;
      renderOptions(o);
    });
    return b;
  }));
  const currentTier = o.plans.find(p => p.current)?.tier ?? 0;
  const cards = o.plans.map(p => planCard(p, o, currentTier));

  root.replaceChildren(
    el("div", { className: "bl" }, [
      header("Top up or upgrade"),
      disabled ? el("div", { className: "bl-warn-text bl-warn", text: "Online payments aren't set up for this Spur workspace yet." }) : null,
      wallet,
      el("div", { className: "bl-row" }, [el("span", { className: "bl-subtitle", text: "Plans" }), toggle]),
      el("div", { className: "bl-plans" }, cards),
      o.has_billing_portal
        ? el("div", { className: "bl-foot" }, [
            el("button", {
              className: "link",
              text: "Manage card, invoices or cancel →",
              onClick: event => void busy(event.currentTarget as HTMLButtonElement, "Opening…", async () => render(await call("spur_manage_billing", {}), o))
            })
          ])
        : null
    ])
  );
}

function planCard(p: Plan, o: Options, currentTier: number) {
  const free = p.monthly_usd === 0;
  const sameInterval = o.current_plan.interval === interval || !o.has_active_subscription;
  const isCurrent = p.current && (free || sameInterval);
  const price = free ? "Free" : interval === "annual" ? `${usd(p.annual_monthly_usd)}/mo` : `${usd(p.monthly_usd)}/mo`;
  const sub = free ? "" : interval === "annual" ? `billed ${usd(p.annual_usd)} yearly` : "billed monthly";

  const action = el("button", {
    className: isCurrent ? "" : p.tier > currentTier ? "primary" : "",
    text: isCurrent ? "Current plan" : p.current ? `Switch to ${interval}` : p.tier > currentTier ? `Upgrade to ${p.name}` : `Switch to ${p.name}`
  });
  action.disabled = isCurrent || !o.stripe_enabled;
  action.addEventListener("click", () => {
    if (o.has_active_subscription && !free) return renderConfirm(p, o);
    void busy(action, "Opening Stripe…", () => changePlan(p.id, false, o));
  });

  return el("div", { className: `bl-plan${isCurrent ? " current" : ""}` }, [
    el("div", { className: "bl-plan-name", text: p.name }),
    el("div", { className: "bl-plan-price", text: price }),
    el("div", { className: "muted bl-small", text: sub }),
    el("ul", {}, p.highlights.map(h => el("li", { text: h }))),
    action
  ]);
}

function autoRechargeControl(o: Options) {
  const ar = o.auto_recharge;
  if (ar.enabled) {
    return el("div", { className: "bl-small" }, [
      el("button", {
        className: "link",
        text: "Turn off auto-recharge",
        onClick: event =>
          void busy(event.currentTarget as HTMLButtonElement, "Turning off…", async () => {
            await call("spur_set_auto_recharge", { enabled: false });
            tell("User turned off wallet auto-recharge from the billing widget.");
            render((await call("spur_show_billing_options", {})) as Options);
          })
      })
    ]);
  }
  if (!ar.card_on_file) return el("div", { className: "muted bl-small", text: "After your first top-up you can turn on auto-recharge so sends never stall." });

  const amount = el("input", { className: "bl-amount", attrs: { type: "number", min: "5", value: "50", "aria-label": "Recharge amount" } });
  const threshold = el("input", { className: "bl-amount", attrs: { type: "number", min: "0", value: "10", "aria-label": "Recharge threshold" } });
  const go = el("button", { text: "Turn on" });
  go.addEventListener("click", () => {
    const a = Number(amount.value);
    const t = Number(threshold.value);
    if (!(a >= 5) || !(t >= 0) || t >= a) return showError("Use an amount of at least $5 and a threshold below it.");
    const yes = el("button", { className: "danger", text: `Yes, auto-charge ${usd(a)}` });
    const no = el("button", { text: "Cancel", onClick: () => renderOptions(o) });
    yes.addEventListener("click", () =>
      void busy(yes, "Saving…", async () => {
        await call("spur_set_auto_recharge", { enabled: true, amount_usd: a, threshold_usd: t, confirm: true });
        tell(`User approved and turned on auto-recharge from the billing widget: ${usd(a)} whenever the wallet drops below ${usd(t)}.`);
        render((await call("spur_show_billing_options", {})) as Options);
      })
    );
    row.replaceChildren(el("div", { className: "bl-confirm", attrs: { role: "alertdialog" } }, [
      el("p", { text: `Charge your saved card ${usd(a)} automatically whenever the wallet drops below ${usd(t)}?` }),
      el("div", { className: "bl-cta" }, [no, yes])
    ]));
  });
  const row = el("div", { className: "bl-auto bl-small" }, [el("span", { className: "muted", text: "Auto-recharge" }), amount, el("span", { className: "muted", text: "when below" }), threshold, go]);
  return row;
}

async function changePlan(planId: string, confirm: boolean, back: Options) {
  const result = await call("spur_change_plan", { plan_id: planId, billing_interval: interval, ...(confirm ? { confirm: true } : {}) });
  if (result.view === "checkout") {
    open(result.checkout_url);
    tell(`User started checkout for the ${planId} plan (${interval}) from the billing widget (session_id ${result.session_id}).`);
    return renderCheckout(result, back);
  }
  if (result.view === "link") return renderLink(result, back);
  if (result.view === "notice" && confirm) {
    tell(`User approved and switched to the ${planId} plan (${interval}) from the billing widget.`);
    return render((await call("spur_show_billing_options", {})) as Options);
  }
  render(result, back);
}

// ---------------------------------------------------------------- secondary views

function renderConfirm(p: Plan, o: Options) {
  const price = interval === "annual" ? `${usd(p.annual_usd)}/yr` : `${usd(p.monthly_usd)}/mo`;
  const yes = el("button", { className: "danger", text: `Yes, switch to ${p.name}` });
  yes.addEventListener("click", () => void busy(yes, "Switching…", () => changePlan(p.id, true, o)));
  root.replaceChildren(
    el("div", { className: "bl" }, [
      header("Change plan", o),
      el("div", { className: "bl-confirm", attrs: { role: "alertdialog" } }, [
        el("p", { text: `Switch to ${p.name} (${price}) now? Your saved card is charged, or credited, the prorated difference for the rest of this period.` }),
        el("div", { className: "bl-cta" }, [el("button", { text: "Cancel", onClick: () => renderOptions(o) }), yes])
      ])
    ])
  );
  yes.focus();
}

function renderCheckout(c: Checkout, back?: Options) {
  const check = el("button", { text: "I've paid: check" });
  check.addEventListener("click", () =>
    void busy(check, "Checking…", async () => {
      const status = await call("spur_check_payment", { session_id: c.session_id });
      if (status.view === "payment_status" && status.paid) tell(`Billing widget: ${status.message}`);
      render(status);
    })
  );
  root.replaceChildren(
    el("div", { className: "bl" }, [
      header(c.purpose === "top_up" ? "Top up wallet" : "Upgrade plan", back),
      el("section", { className: "bl-card bl-center" }, [
        el("div", { className: "bl-plan-name", text: c.label }),
        el("button", { className: "primary bl-pay", text: "Pay securely with Stripe →", onClick: () => open(c.checkout_url) }),
        el("div", { className: "muted bl-small", text: "Stripe opens in your browser. Card details never pass through the chat." }),
        check,
        el("a", { className: "bl-url bl-small", text: c.checkout_url, attrs: { href: c.checkout_url, target: "_blank", rel: "noopener" } })
      ])
    ])
  );
}

function renderLink(l: { message: string; label: string; url: string }, back?: Options) {
  root.replaceChildren(
    el("div", { className: "bl" }, [
      header("Billing", back),
      el("section", { className: "bl-card bl-center" }, [
        el("p", { text: l.message }),
        el("button", { className: "primary", text: `${l.label} →`, onClick: () => open(l.url) }),
        el("a", { className: "bl-url bl-small", text: l.url, attrs: { href: l.url, target: "_blank", rel: "noopener" } })
      ])
    ])
  );
}

function render(p: Payload, back?: Options) {
  switch (p.view) {
    case "options":
      return renderOptions(p);
    case "checkout":
      return renderCheckout(p, back);
    case "link":
      return renderLink(p, back);
    case "payment_status":
      if (p.paid) {
        renderOptions(p.options);
        root.querySelector(".bl-head")?.after(el("div", { className: "bl-done bl-status", attrs: { role: "status" }, text: `✓ ${p.message}` }));
        return;
      }
      return root.replaceChildren(
        el("div", { className: "bl" }, [
          header("Payment", p.options),
          el("section", { className: "bl-card bl-center" }, [el("p", { text: p.message })])
        ])
      );
    case "confirm_plan": {
      // The assistant asked to switch an active subscription; the user approves here or in the chat
      interval = p.billing_interval;
      const yes = el("button", { className: "danger", text: `Yes, switch to ${p.plan_name}` });
      yes.addEventListener("click", () => void busy(yes, "Switching…", () => changePlanFromChat(p.plan_id)));
      return root.replaceChildren(
        el("div", { className: "bl" }, [
          header("Change plan"),
          el("div", { className: "bl-confirm", attrs: { role: "alertdialog" } }, [
            el("p", { text: `Switch to ${p.plan_name} (${p.price}) now? Your saved card is charged, or credited, the prorated difference.` }),
            el("div", { className: "bl-cta" }, [yes])
          ])
        ])
      );
    }
    case "notice":
      return root.replaceChildren(
        el("div", { className: "bl" }, [
          header("Billing", back),
          el("div", { className: p.tone === "good" ? "bl-done bl-status" : "bl-card", attrs: { role: "status" }, text: p.message })
        ])
      );
  }
}

async function changePlanFromChat(planId: string) {
  await call("spur_change_plan", { plan_id: planId, billing_interval: interval, confirm: true });
  tell(`User approved and switched to the ${planId} plan (${interval}) from the billing widget.`);
  render((await call("spur_show_billing_options", {})) as Options);
}

connect("spur-billing", (result, connected) => {
  app = connected;
  if (result.isError || !result.structuredContent) {
    root.replaceChildren(el("div", { className: "empty", text: resultText(result) || "Billing is unavailable right now." }));
    return;
  }
  render(result.structuredContent as unknown as Payload);
}).catch(() => {
  root.replaceChildren(el("div", { className: "empty", text: "Could not connect to the host." }));
});
