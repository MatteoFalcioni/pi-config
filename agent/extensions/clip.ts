/**
 * Standalone /clip command: copy text (or the last assistant reply) to the
 * macOS clipboard. No TTS dependency — a general-purpose utility.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

async function clipboardSet(text: string): Promise<void> {
  const child = spawn("pbcopy");
  child.stdin.write(text);
  child.stdin.end();
  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
    child.on("error", reject);
  });
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

export default function (pi: ExtensionAPI) {
  pi.registerCommand("clip", {
    description: "Copy text (or the last assistant reply) to the clipboard",
    handler: async (args: string, ctx) => {
      const direct = args.trim();
      const text = direct !== "" ? direct : lastAssistantText(ctx);
      if (!text) {
        ctx.ui.notify("Nothing to copy: pass text or have an assistant reply first", "error");
        return;
      }
      await clipboardSet(text);
      ctx.ui.notify(`Copied ${text.length} chars to clipboard`, "info");
    },
  });
}