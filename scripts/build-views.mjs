/**
 * Bundles each widget (views/<name>.ts + its CSS) into one self-contained HTML file in dist/views.
 * Hosts render widgets in sandboxed iframes, so scripts and styles are inlined.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist", "views");
const views = ["property-explorer", "postcard-preview", "message-preview", "billing", "image-upload"];

mkdirSync(outDir, { recursive: true });

for (const name of views) {
  const result = await build({
    entryPoints: [join(root, "views", `${name}.ts`)],
    bundle: true,
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    outdir: "out",
    legalComments: "none",
    // Leaflet CSS references marker/layer PNGs we never show (pins are HTML); inline them anyway
    loader: { ".png": "dataurl" },
    logLevel: "warning"
  });
  const js = result.outputFiles.find(f => f.path.endsWith(".js"))?.text ?? "";
  const css = result.outputFiles.find(f => f.path.endsWith(".css"))?.text ?? "";
  const shell = readFileSync(join(root, "views", `${name}.html`), "utf8");
  // A literal "</script" inside the bundle would end the inline script early
  const html = shell
    .replace("/*STYLE*/", () => css.replace(/<\/style/gi, "<\\/style"))
    .replace("/*SCRIPT*/", () => js.replace(/<\/script/gi, "<\\/script"));
  writeFileSync(join(outDir, `${name}.html`), html);
  console.error(`built dist/views/${name}.html (${Math.round(html.length / 1024)} KB)`);
}
