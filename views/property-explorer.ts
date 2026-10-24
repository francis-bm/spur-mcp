/**
 * Property explorer widget: price-pin map + cards for search results, saved properties and details.
 * Card actions call Spur tools through the host (save) or hand the next step to the assistant.
 */
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./base.css";
import "./property-explorer.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { askAssistant, connect, el, resultText, spurConfig, usd, type ToolResultPayload } from "./shared.js";

interface Card {
  key: string;
  source: "listing" | "saved";
  propertyId?: string;
  zpid?: string;
  address: string;
  cityLine: string;
  lat?: number;
  lng?: number;
  price?: number;
  listingStatus?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  yearBuilt?: number;
  propertyType?: string;
  photoUrl?: string;
  daysOnMarket?: number;
  zestimate?: number;
  rentZestimate?: number;
  url?: string;
  contactName?: string;
  enrichmentStatus?: string;
  listing?: Record<string, unknown>;
}

interface Payload {
  view?: string;
  title?: string;
  mode?: "search" | "saved" | "detail";
  cards?: Card[];
  total?: number;
  next_offset?: number;
}

const root = document.getElementById("root") as HTMLElement;
let app: App;
let map: L.Map | null = null;
let markers = new Map<string, L.Marker>();
const cardNodes = new Map<string, HTMLElement>();
const savedKeys = new Set<string>();
let activeKey: string | null = null;
let showMap = true;

function toast(message: string, isError = false) {
  const node = el("div", { className: `toast${isError ? " error" : ""}`, text: message, attrs: { role: "status" } });
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

const priceText = (card: Card) => (card.price ? `${usd(card.price)}${card.listingStatus === "forRent" ? "/mo" : ""}` : "Price n/a");

const shortPrice = (card: Card) => {
  if (!card.price) return "—";
  if (card.price >= 1_000_000) return `$${(card.price / 1_000_000).toFixed(card.price >= 10_000_000 ? 0 : 1)}M`;
  if (card.price >= 10_000) return `$${Math.round(card.price / 1000)}K`;
  return `$${card.price.toLocaleString("en-US")}`;
};

function setActive(key: string | null, { scroll = false, pan = false } = {}) {
  if (activeKey) {
    cardNodes.get(activeKey)?.classList.remove("active");
    markers.get(activeKey)?.getElement()?.querySelector(".pe-pin")?.classList.remove("active");
  }
  activeKey = key;
  if (!key) return;
  const card = cardNodes.get(key);
  card?.classList.add("active");
  const marker = markers.get(key);
  marker?.getElement()?.querySelector(".pe-pin")?.classList.add("active");
  marker?.setZIndexOffset(1000);
  if (scroll) card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (pan && marker && map) map.panTo(marker.getLatLng());
}

async function saveListings(cards: Card[], button: HTMLButtonElement) {
  const listings = cards.filter(c => c.listing && !savedKeys.has(c.key)).map(c => c.listing);
  if (!listings.length) return;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const result = (await app.callServerTool({ name: "spur_save_properties", arguments: { listings } })) as ToolResultPayload;
    if (result.isError) throw new Error(resultText(result) || "Save failed");
    for (const c of cards) savedKeys.add(c.key);
    button.textContent = cards.length > 1 ? "Saved all" : "Saved ✓";
    toast(cards.length > 1 ? `Saved ${listings.length} properties to Spur` : "Saved to Spur");
    // Keep the assistant in the loop so its next answer knows what changed
    await app
      .updateModelContext({ content: [{ type: "text", text: `User saved via widget: ${resultText(result)}` }] })
      .catch(() => undefined);
    for (const c of cards) {
      const btn = cardNodes.get(c.key)?.querySelector<HTMLButtonElement>("button[data-save]");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Saved ✓";
      }
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    toast((error as Error).message, true);
  }
}

function renderCard(card: Card, detail: boolean): HTMLElement {
  const facts = [card.beds ? `${card.beds} bd` : "", card.baths ? `${card.baths} ba` : "", card.sqft ? `${card.sqft.toLocaleString()} sqft` : "", card.yearBuilt ? `Built ${card.yearBuilt}` : ""]
    .filter(Boolean)
    .join(" · ");
  const photo = el("div", { className: "pe-photo", attrs: { role: "img", "aria-label": `Photo of ${card.address}` } }, [
    card.propertyType ? el("span", { className: "chip", text: card.propertyType }) : null
  ]);
  if (card.photoUrl) photo.style.backgroundImage = `url("${card.photoUrl.replace(/"/g, "%22")}")`;

  const meta = el("div", { className: "pe-meta" }, [
    card.daysOnMarket !== undefined ? el("span", { className: "chip", text: `${card.daysOnMarket}d on market` }) : null,
    card.zestimate ? el("span", { className: "chip", text: `Zest. ${usd(card.zestimate)}` }) : null,
    card.rentZestimate ? el("span", { className: "chip", text: `Rent est. ${usd(card.rentZestimate)}` }) : null,
    card.enrichmentStatus ? el("span", { className: "chip", text: `Owner: ${card.enrichmentStatus}` }) : null
  ]);

  const buttons: HTMLElement[] = [];
  if (card.source === "listing" && card.listing) {
    const save = el("button", { className: "primary", text: savedKeys.has(card.key) ? "Saved ✓" : "Save", attrs: { "data-save": "1" } });
    save.disabled = savedKeys.has(card.key);
    save.addEventListener("click", event => {
      event.stopPropagation();
      void saveListings([card], save);
    });
    buttons.push(save);
  }
  if (!detail) {
    buttons.push(
      el("button", {
        text: "Details",
        onClick: event => {
          event.stopPropagation();
          void askAssistant(app, card.propertyId ? `Show details for ${card.address} (property_id ${card.propertyId}).` : `Show details for ${card.address} (zpid ${card.zpid}).`);
        }
      })
    );
  }
  if (card.source === "saved" && card.propertyId) {
    buttons.push(
      el("button", {
        text: card.enrichmentStatus === "enriched" ? "Owner" : "Find owner",
        onClick: event => {
          event.stopPropagation();
          void askAssistant(
            app,
            card.enrichmentStatus === "enriched"
              ? `Show me the owner of ${card.address} (property_id ${card.propertyId}).`
              : `Find the owner of ${card.address} (property_id ${card.propertyId}). Tell me the skip-trace cost first.`
          );
        }
      })
    );
  }
  const link = card.url || (card.propertyId && spurConfig.appUrl ? `${spurConfig.appUrl}/properties/${card.propertyId}` : "");
  if (link) {
    buttons.push(
      el("button", {
        className: "link",
        text: card.url ? "Zillow ↗" : "Spur ↗",
        onClick: event => {
          event.stopPropagation();
          void app.openLink({ url: link }).catch(() => undefined);
        }
      })
    );
  }

  const node = el("article", { className: `pe-card${detail ? " detail" : ""}`, attrs: { tabindex: "0", "aria-label": `${card.address}, ${priceText(card)}` } }, [
    photo,
    el("div", { className: "pe-body" }, [
      el("div", { className: "pe-price", text: priceText(card) }),
      el("div", { className: "pe-addr", text: card.address }),
      el("div", { className: "pe-city", text: card.cityLine }),
      facts ? el("div", { className: "pe-facts", text: facts }) : null,
      card.contactName ? el("div", { className: "pe-facts", text: `Contact: ${card.contactName}` }) : null,
      meta,
      el("div", { className: "pe-buttons" }, buttons)
    ])
  ]);
  node.addEventListener("click", () => setActive(card.key, { pan: true }));
  node.addEventListener("focus", () => setActive(card.key, { pan: true }));
  cardNodes.set(card.key, node);
  return node;
}

function renderMap(container: HTMLElement, cards: Card[]) {
  map?.remove();
  map = null;
  markers = new Map();
  const located = cards.filter(c => c.lat !== undefined && c.lng !== undefined);
  if (!located.length) {
    container.classList.add("hidden");
    return;
  }
  map = L.map(container, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer(spurConfig.tileUrl, { attribution: spurConfig.tileAttribution, maxZoom: 19 }).addTo(map);
  for (const card of located) {
    const icon = L.divIcon({ className: "", html: `<span class="pe-pin">${shortPrice(card)}</span>`, iconSize: [0, 0] });
    const marker = L.marker([card.lat as number, card.lng as number], { icon, title: card.address, keyboard: true }).addTo(map);
    marker.on("click", () => setActive(card.key, { scroll: true }));
    markers.set(card.key, marker);
  }
  const bounds = L.latLngBounds(located.map(c => [c.lat as number, c.lng as number] as [number, number]));
  if (located.length === 1) map.setView(bounds.getCenter(), 15);
  else map.fitBounds(bounds, { padding: [28, 28], maxZoom: 15 });
  // The iframe may still be sizing itself on first paint
  setTimeout(() => map?.invalidateSize(), 150);
}

function render(payload: Payload) {
  const cards = payload.cards || [];
  cardNodes.clear();
  root.replaceChildren();
  if (!cards.length) {
    root.append(el("div", { className: "empty", text: payload.title || "No properties to show." }));
    return;
  }
  const detail = payload.mode === "detail";
  const mapNode = el("div", { className: `pe-map${showMap ? "" : " hidden"}`, attrs: { role: "region", "aria-label": "Map of properties" } });
  const unsaved = cards.filter(c => c.source === "listing" && c.listing && !savedKeys.has(c.key));

  const actions = el("div", { className: "pe-actions" });
  if (payload.mode === "search" && unsaved.length > 1) {
    const saveAll = el("button", { text: `Save all ${unsaved.length}` });
    saveAll.addEventListener("click", () => void saveListings(unsaved, saveAll));
    actions.append(saveAll);
  }
  if (!detail && cards.some(c => c.lat !== undefined)) {
    actions.append(
      el("button", {
        text: showMap ? "Hide map" : "Show map",
        onClick: event => {
          showMap = !showMap;
          (event.currentTarget as HTMLButtonElement).textContent = showMap ? "Hide map" : "Show map";
          mapNode.classList.toggle("hidden", !showMap);
          if (showMap) setTimeout(() => map?.invalidateSize(), 50);
        }
      })
    );
  }
  const modes = app.getHostContext()?.availableDisplayModes || [];
  if (modes.includes("fullscreen")) {
    actions.append(
      el("button", {
        text: "Expand",
        onClick: event => {
          const btn = event.currentTarget as HTMLButtonElement;
          const next = document.body.classList.contains("fullscreen") ? "inline" : "fullscreen";
          void app.requestDisplayMode({ mode: next }).then(({ mode }) => {
            document.body.classList.toggle("fullscreen", mode === "fullscreen");
            btn.textContent = mode === "fullscreen" ? "Collapse" : "Expand";
            setTimeout(() => map?.invalidateSize(), 100);
          });
        }
      })
    );
  }

  const grid = el("div", { className: "pe-grid" }, cards.map(c => renderCard(c, detail)));
  root.append(
    el("div", { className: "pe" }, [
      el("div", { className: "pe-head" }, [el("div", { className: "pe-title", text: payload.title || `${cards.length} properties` }), actions]),
      mapNode,
      grid,
      payload.next_offset !== undefined
        ? el("div", { className: "pe-more" }, [
            el("button", {
              className: "link",
              text: `Show more (${(payload.total || 0) - payload.next_offset} remaining)`,
              onClick: () => void askAssistant(app, `Show the next page of saved properties (offset ${payload.next_offset}).`)
            })
          ])
        : null
    ])
  );
  renderMap(mapNode, cards);
}

connect("spur-property-explorer", (result, connected) => {
  app = connected;
  const payload = (result.structuredContent || {}) as Payload;
  if (result.isError) {
    root.replaceChildren(el("div", { className: "empty", text: resultText(result) || "Something went wrong." }));
    return;
  }
  if (payload.view === "property-explorer") render(payload);
})
  .then(connected => {
    app = connected;
  })
  .catch(error => {
    root.replaceChildren(el("div", { className: "empty", text: `Could not connect to the assistant: ${(error as Error).message}` }));
  });
