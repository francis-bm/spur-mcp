/**
 * Vercel function entry: every path is rewritten here (see vercel.json) and handled by the Express app.
 * Imports the compiled build, so `npm run build` must run first (vercel.json's buildCommand does).
 */
import { createHttpApp, resolveTokenSecret } from "../dist/app.js";
import { Sealer } from "../dist/auth/seal.js";

export default createHttpApp(new Sealer(resolveTokenSecret()));
