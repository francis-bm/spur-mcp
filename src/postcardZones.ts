/**
 * USPS clear zones on a postcard back, mirroring the white boxes the backend paints over the back
 * when it prints (backend/src/utils/postcardUtils.js POSTCARD_SPECS). Anything designed into these
 * areas is covered on the printed card, so the MCP shows, checks and explains them.
 *
 * Geometry is in inches from the top-left of the bleed box (trim + 0.125" on every edge).
 * Dependency-free so the regression suite can compare it with the backend spec.
 */
export const POSTCARD_BLEED_IN = 0.125;

/** Trim size in inches, landscape (width × height) */
export const POSTCARD_TRIM_IN = { "6x4": [6, 4], "6x9": [9, 6], "6x11": [11, 6] } as const;
export type ZoneSize = keyof typeof POSTCARD_TRIM_IN;

export interface ClearZone {
  id: "postage" | "address" | "barcode";
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Same values for every size today; kept per size so a backend change maps one-to-one */
const ZONE_SPEC: Record<ZoneSize, { postage: [number, number]; address: { w: number; h: number; right: number; top: number }; barcode: [number, number] }> = {
  "6x4": { postage: [1.25, 1.25], address: { w: 3.5, h: 2, right: 0.5, top: 1.35 }, barcode: [4.75, 0.625] },
  "6x9": { postage: [1.25, 1.25], address: { w: 3.5, h: 2, right: 0.5, top: 1.35 }, barcode: [4.75, 0.625] },
  "6x11": { postage: [1.25, 1.25], address: { w: 3.5, h: 2, right: 0.5, top: 1.35 }, barcode: [4.75, 0.625] }
};

export function bleedInches(size: ZoneSize): [number, number] {
  const [w, h] = POSTCARD_TRIM_IN[size];
  return [w + POSTCARD_BLEED_IN * 2, h + POSTCARD_BLEED_IN * 2];
}

export function clearZones(size: ZoneSize): ClearZone[] {
  const [bw, bh] = bleedInches(size);
  const s = ZONE_SPEC[size];
  return [
    { id: "postage", label: "Postage", x: bw - s.postage[0], y: 0, w: s.postage[0], h: s.postage[1] },
    { id: "address", label: "Address block", x: bw - s.address.right - s.address.w, y: s.address.top, w: s.address.w, h: s.address.h },
    { id: "barcode", label: "USPS barcode", x: bw - s.barcode[0], y: bh - s.barcode[1], w: s.barcode[0], h: s.barcode[1] }
  ];
}

/** One-line geometry per zone for tool text, in inches and in px at the 300 px/in authoring scale */
export function describeClearZones(size: ZoneSize, pxPerIn = 300): string {
  const px = (v: number) => Math.round(v * pxPerIn);
  return clearZones(size)
    .map(z => `${z.label}: x ${z.x}–${+(z.x + z.w).toFixed(3)}in, y ${z.y}–${+(z.y + z.h).toFixed(3)}in (px ${px(z.x)}–${px(z.x + z.w)} × ${px(z.y)}–${px(z.y + z.h)})`)
    .join("; ");
}

/**
 * Left-hand message area that clears every zone with a 0.125" gap: inside the safe margin, left of
 * the address block and above the barcode strip (which reaches further left than the address).
 */
export function messageArea(size: ZoneSize): { x: number; y: number; w: number; h: number } {
  const [, bh] = bleedInches(size);
  const margin = POSTCARD_BLEED_IN * 2;
  const gap = 0.125;
  const zones = clearZones(size);
  const address = zones.find(z => z.id === "address") as ClearZone;
  const barcode = zones.find(z => z.id === "barcode") as ClearZone;
  return { x: margin, y: margin, w: address.x - gap - margin, h: bh - barcode.h - gap - margin };
}
