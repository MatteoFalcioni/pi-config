/**
 * Direct /speak command for the tts skill (no LLM round trip).
 *
 * /speak [text] [--model 0.6b|1.7b] [--lang xx] [--voice name] [--no-play]
 *   - captures text: command args > last assistant reply > clipboard
 *   - copies the captured text to the clipboard (side effect)
 *   - speaks it with the local TTS script (small model by default, plays audio)
 *
 * No manual /clip needed: /speak clips and reads in one go.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

const PY = join(homedir(), ".local/venvs/tts/bin/python");
const TTS_SCRIPT = join(homedir(), ".pi", "agent", "skills", "tts", "scripts", "tts.py");
const MAX_CHARS = 4000;

const FORWARDED_FLAGS = new Set([
  "--model", "--lang", "--voice", "--no-play",
  "--temperature", "--repetition-penalty", "--max-tokens", "--out",
]);

function parseArgs(args: string): { flags: string[]; text: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const flags: string[] = [];
  const textParts: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const base = tok.includes("=") ? tok.slice(0, tok.indexOf("=")) : tok;
    if (tok.startsWith("--") && FORWARDED_FLAGS.has(base)) {
      flags.push(tok);
      if (!tok.includes("=") && !tok.startsWith("--no-")) {
        const val = tokens[i + 1];
        if (val !== undefined) {
          flags.push(val);
          i++;
        }
      }
    } else {
      textParts.push(tok);
    }
  }
  return { flags, text: textParts.join(" ") };
}

function clipboardSet(text: string): Promise<void> {
  const child = spawn("pbcopy");
  child.stdin.write(text);
  child.stdin.end();
  return new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
    child.on("error", reject);
  });
}

async function clipboardGet(): Promise<string> {
  const { stdout } = await execFileAsync("pbpaste");
  return stdout;
}

function lastAssistantText(ctx: any): string | null {
  const entries = ctx.sessionManager?.getEntries?.() ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const msg = entry?.message ?? entry; // session entries nest the message
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b: any) => b && b.type === "text" && typeof b.text === "string")
        .map((b: any) => b.text)
        .join("\n");
    }
    text = text.trim();
    if (text) return text;
  }
  return null;
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS).trimEnd() + " […]";
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("speak", {
    description: "Clip and speak: text (or last reply, or clipboard) with local TTS",
    handler: async (args: string, ctx) => {
      const { flags, text: argText } = parseArgs(args);

      let text = argText;
      let source = "command text";
      if (!text) {
        text = lastAssistantText(ctx);
        source = "last assistant reply";
      }
      if (!text) {
        text = (await clipboardGet().catch(() => "")).trim();
        source = "clipboard";
      }
      if (!text.trim()) {
        ctx.ui.notify("Nothing to speak: add text, or have an assistant reply / clipboard content first", "error");
        return;
      }
      text = truncate(text.trim());
      ctx.ui.notify(`Speaking ${text.length} chars (${source})…`, "info");

      // Side effect: clip what we are about to speak
      await clipboardSet(text).catch(() => {});

      const out: string[] = [];
      // /speak never STARTS a daemon (only an explicit `--daemon` run does);
      // it may reuse one that is already alive, which is fine.
      const child = spawn(PY, [TTS_SCRIPT, ...flags], { stdio: ["pipe", "inherit", "inherit"] });
      child.stdin.write(text);
      child.stdin.end();
      child.stdout.on("data", (d) => out.push(String(d)));
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", (c) => resolve(c));
        child.on("error", () => resolve(-1));
      });
      const lastLine = out.join("").trim().split("\n").filter((l) => l.includes("[tts]")).pop() ?? "";
      if (code === 0) {
        ctx.ui.notify(lastLine || "Spoken.", "success");
      } else {
        ctx.ui.notify(lastLine || `tts.py failed (exit ${code})`, "error");
      }
    },
  });
}