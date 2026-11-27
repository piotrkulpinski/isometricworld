/**
 * Deploy the built site (web/dist) to Cloudflare Workers on the custom domain SITE_DOMAIN (.env).
 * Outward-facing: run only when you mean to update the live site. `npm run deploy` builds first.
 * WORKER_NAME (.env) deploys under another Worker name than wrangler.jsonc's, for a site in another account.
 */
import { spawnSync } from "node:child_process";
import { ROOT } from "./paths.ts";

const domain = process.env.SITE_DOMAIN;
if (!domain) throw new Error("SITE_DOMAIN is not set: add it to .env (see .env.example)");
const name = process.env.WORKER_NAME ? ["--name", process.env.WORKER_NAME] : [];
const r = spawnSync("npx", ["wrangler", "deploy", "--domain", domain, ...name], { cwd: ROOT, stdio: "inherit" });
process.exit(r.status ?? 1);
