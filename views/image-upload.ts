/**
 * Image uploader: the user picks or drops images from their device and each one is saved to their
 * Spur image library through spur_save_uploaded_image. Large photos are resized in the browser
 * first (to print resolution, under the tool-call size limit) so uploads fit through any host.
 */
import "./base.css";
import "./image-upload.css";
import type { App } from "@modelcontextprotocol/ext-apps";
import { askAssistant, connect, el, resultText, type ToolResultPayload } from "./shared.js";

const SUPPORTED = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
/** Raster types the browser can redraw smaller; GIF (animation) and SVG upload as they are */
const RESIZABLE = ["image/jpeg", "image/png", "image/webp"];
/** Long edge: enough for an 11x6 postcard at 300 px/in with bleed (3375 px) */
const MAX_EDGE = 3600;

let maxBytes = 3 * 1024 * 1024;
let purpose = "";
let busy = false;

const root = document.getElementById("root") as HTMLElement;
const status = el("div", { className: "iu-status", attrs: { role: "status", "aria-live": "polite" } });
const list = el("div", { className: "iu-list" });
const input = el("input", { attrs: { type: "file", accept: SUPPORTED.join(",") + ",image/*", multiple: "" } });
const drop = el("label", { className: "iu-drop" }, [
  input,
  el("strong", { text: "Drop an image here" }),
  el("span", { className: "muted", text: "or" }),
  el("span", { className: "chip", text: "Choose file" }),
  el("span", { className: "iu-hint muted", text: "JPG, PNG, WebP, GIF or SVG. Big photos are resized to print quality." })
]);
const purposeLine = el("div", { className: "iu-purpose muted" });

let resolveApp!: (app: App) => void;
const appReady = new Promise<App>(resolve => (resolveApp = resolve));

function setStatus(text: string, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

const readDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Couldn't read the file."));
    reader.readAsDataURL(blob);
  });

const toBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't resize the image."))), type, quality));

const renamed = (name: string, type: string) => `${name.replace(/\.[a-z0-9]{1,5}$/i, "") || "image"}.${type === "image/png" ? "png" : "jpg"}`;

/** The file as it will be uploaded: unchanged when it already fits, else redrawn smaller */
async function prepare(file: File): Promise<{ blob: Blob; name: string }> {
  const known = SUPPORTED.includes(file.type);
  if (known && !RESIZABLE.includes(file.type)) {
    if (file.size > maxBytes) throw new Error(`${file.name} is over ${Math.round(maxBytes / 1024 / 1024)} MB. Use a smaller file, or ask to save it from a link instead.`);
    return { blob: file, name: file.name };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: use a JPG, PNG, WebP, GIF or SVG image.`);
  }
  const edge = Math.max(bitmap.width, bitmap.height);
  if (known && file.size <= maxBytes && edge <= MAX_EDGE) return { blob: file, name: file.name };

  // PNG/WebP may have transparency (logos), so they stay PNG; photos and other formats become JPEG
  const type = file.type === "image/png" || file.type === "image/webp" ? "image/png" : "image/jpeg";
  let scale = Math.min(1, MAX_EDGE / edge);
  let quality = 0.9;
  const canvas = document.createElement("canvas");
  for (let attempt = 0; attempt < 8; attempt++) {
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) break;
    if (type === "image/jpeg") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await toBlob(canvas, type, quality);
    if (blob.size <= maxBytes) return { blob, name: renamed(file.name, type) };
    if (type === "image/jpeg" && quality > 0.7) quality -= 0.1;
    else scale *= 0.8;
  }
  throw new Error(`${file.name} is too large to upload here even after resizing.`);
}

function addSaved(name: string, url: string, thumb: string, app: App) {
  const use = el("button", { className: "primary", text: "Use this image" });
  use.addEventListener("click", () => {
    use.disabled = true;
    use.textContent = "Sent to chat";
    void askAssistant(app, `I uploaded "${name}" to my Spur image library: ${url}. ${purpose ? `Use it for: ${purpose}.` : "Use it in the design."}`);
  });
  list.prepend(
    el("div", { className: "iu-item" }, [
      el("img", { attrs: { src: thumb, alt: name } }),
      el("div", {}, [el("div", { className: "iu-name", text: name }), el("div", { className: "iu-ok", text: "✓ Saved to your Spur images" }), el("div", { className: "iu-url", text: url })]),
      use
    ])
  );
}

async function upload(files: File[]) {
  if (busy || !files.length) return;
  busy = true;
  drop.classList.add("busy");
  const app = await appReady;
  const saved: string[] = [];
  try {
    for (const [i, file] of files.entries()) {
      setStatus(`${files.length > 1 ? `${i + 1}/${files.length}: ` : ""}Preparing ${file.name}…`);
      try {
        const { blob, name } = await prepare(file);
        const dataUrl = await readDataUrl(blob);
        setStatus(`${files.length > 1 ? `${i + 1}/${files.length}: ` : ""}Uploading ${name}…`);
        const result = (await app.callServerTool({
          name: "spur_save_uploaded_image",
          arguments: { filename: name, data_base64: dataUrl.slice(dataUrl.indexOf(",") + 1) }
        })) as ToolResultPayload;
        if (result.isError) throw new Error(resultText(result) || "Upload failed.");
        const image = (result.structuredContent?.image || {}) as { filename?: string; url?: string };
        if (!image.url) throw new Error("Upload failed.");
        addSaved(image.filename || name, image.url, dataUrl, app);
        saved.push(`"${image.filename || name}": ${image.url}`);
      } catch (error) {
        setStatus((error as Error).message, true);
        if (files.length === 1) return;
      }
    }
    if (saved.length) {
      setStatus(saved.length === 1 ? "Saved. Click “Use this image” or tell the assistant where to put it." : `Saved ${saved.length} images.`);
      await app
        .updateModelContext({ content: [{ type: "text", text: `The user uploaded to their Spur image library: ${saved.join("; ")}.${purpose ? ` Purpose: ${purpose}.` : ""}` }] })
        .catch(() => undefined);
    }
  } finally {
    busy = false;
    drop.classList.remove("busy");
    input.value = "";
  }
}

input.addEventListener("change", () => void upload([...(input.files || [])]));
drop.addEventListener("dragover", event => {
  event.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", event => {
  event.preventDefault();
  drop.classList.remove("over");
  void upload([...(event.dataTransfer?.files || [])]);
});

root.replaceChildren(el("div", { className: "iu" }, [el("div", {}, [el("div", { className: "iu-title", text: "Upload an image to Spur" }), purposeLine]), drop, status, list]));

void connect("spur-image-upload", (result, app) => {
  const payload = (result.structuredContent || {}) as { purpose?: string | null; max_bytes?: number };
  purpose = payload.purpose || "";
  purposeLine.textContent = purpose;
  if (payload.max_bytes) maxBytes = payload.max_bytes;
  resolveApp(app);
}).then(resolveApp);
