/** One Codex CLI run (`codex exec`, ChatGPT login, no API key) in `cwd` with the given images attached; log in cwd/codex.log. */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * `--ephemeral`: no session files. Each run with images persisted ~13 MB of base64 under $CODEX_HOME/sessions (a whole
 * city's painting filled a 228 GB disk in a day); the log in cwd/codex.log is the record. Point CODEX_HOME at a big disk
 * too (generated_images and the thread database live there), with links to ~/.codex/auth.json and config.toml.
 * `model`: the Codex model that drives the image tool (else CODEX_MODEL, else ~/.codex/config.toml's);
 * `effort`: its reasoning effort.
 */
export function codex(cwd: string, images: string[], prompt: string, opts: { model?: string; effort?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const codexModel = opts.model ?? process.env.CODEX_MODEL;
    const model = [...(codexModel ? ["-m", codexModel] : []), ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : [])];
    const p = spawn("codex", ["exec", "--ephemeral", "--skip-git-repo-check", "-s", "workspace-write", ...model, "-C", cwd, ...images.flatMap((f) => ["-i", f]), "-"],
      { stdio: ["pipe", log, log] });
    const timer = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs ?? 900_000);
    p.on("close", () => { clearTimeout(timer); closeSync(log); resolve(); });
    p.stdin!.end(prompt);
  });
}
