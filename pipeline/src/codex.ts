/** One Codex CLI run (`codex exec`, ChatGPT login, no API key) in `cwd` with the given images attached; log in cwd/codex.log. */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * No --ephemeral: the image tool reads the attached images back from the session ("requested the last 5 conversation
 * images, but only 0 were available" without one). Each run with images persists ~13 MB under $CODEX_HOME/sessions:
 * give painting its own CODEX_HOME (links to ~/.codex/auth.json and config.toml) on a fast disk, and move old sessions
 * and generated_images off it. On a hard disk, parallel runs lost the same images in a third of the calls (Kraków, Nov 2026).
 * `model`: the Codex model that drives the image tool (else CODEX_MODEL, else ~/.codex/config.toml's);
 * `effort`: its reasoning effort.
 */
export function codex(cwd: string, images: string[], prompt: string, opts: { model?: string; effort?: string; timeoutMs?: number } = {}): Promise<void> {
  return new Promise((resolve) => {
    const log = openSync(join(cwd, "codex.log"), "w");
    const codexModel = opts.model ?? process.env.CODEX_MODEL;
    const model = [...(codexModel ? ["-m", codexModel] : []), ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : [])];
    // CODEX_ISOLATE=1: every call gets its own throwaway CODEX_HOME (links to the base home's auth.json and config.toml).
    // Parallel calls sharing one home lost their attached images ("only 0 were available") or painted another
    // call's place (Kraków, Nov 2026): the image tool reads "the last conversation images" from the shared history.
    let home: string | undefined;
    if (process.env.CODEX_ISOLATE) {
      const base = process.env.CODEX_HOME || join(homedir(), ".codex");
      home = join(cwd, ".codex-home");
      rmSync(home, { recursive: true, force: true });
      mkdirSync(home, { recursive: true });
      for (const f of ["auth.json", "config.toml"]) if (existsSync(join(base, f))) symlinkSync(join(base, f), join(home, f));
    }
    const p = spawn("codex", ["exec", "--skip-git-repo-check", "-s", "workspace-write", ...model, "-C", cwd, ...images.flatMap((f) => ["-i", f]), "-"],
      { stdio: ["pipe", log, log], env: home ? { ...process.env, CODEX_HOME: home } : process.env });
    const timer = setTimeout(() => p.kill("SIGTERM"), opts.timeoutMs ?? 900_000);
    p.on("close", () => { clearTimeout(timer); closeSync(log); if (home) rmSync(home, { recursive: true, force: true }); resolve(); });
    p.stdin!.end(prompt);
  });
}
