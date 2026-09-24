/**
 * dictate — voice dictation for pi, fully local.
 *
 * Two flows:
 *
 * 1. ctrl+space / F6 — global voice dictation, no agent in the loop.
 *    ctrl+space starts recording (or cancels it if pressed again while
 *    recording); the local pipeline (~/.local/bin/dictate: Silero VAD
 *    endpointing + Whisper small.en on Metal) stops by itself ~1s after
 *    you stop talking. The transcript is delivered to whatever input is
 *    focused at that moment. F6 is a dedicated cancel kill-switch.
 *
 *    ctrl+space arrives as NUL (\x00) in legacy terminals, which pi's key
 *    parser maps to "ctrl+space" — unbound in pi's defaults, unused by
 *    macOS on this machine, and not a printable character, so nothing is
 *    sacrificed. Keys are debounced so holding a key cannot fire repeats.
 *
 * 2. /dictate [instruction] — records and sends the transcript to the
 *    agent as your user message (optional instruction appended, e.g.
 *    `/dictate summarize this`).
 *
 * Focus-aware delivery: ctrl+space/F6 are intercepted at the TUI input layer
 * (before any focused component), so dictation works inside ANY dialog —
 * quiz popups, ask_user_question, ctx.ui.editor()/input() — not just the
 * main chat editor.
 *
 * Start rule: recording only begins if some text-capable component is
 * focused; otherwise a notification explains why nothing happened. Opaque
 * dialogs (quiz/ask selects) count as text-capable, but their internal
 * focus is invisible to us — Tab into the note/Other field first so the
 * text lands there.
 *
 * Stop rule: the delivery target is resolved fresh at stop time and goes
 * to whatever is focused THEN (editor-like components get a direct setText
 * append; opaque components get synthetic keystrokes). If nothing
 * text-capable is focused at stop, the transcript is copied to the
 * clipboard and a notification says so — a finished dictation is never
 * lost.
 *
 * Backend: the dictation is captured and transcribed by the local whisper
 * pipeline (~/.local/bin/dictate, whisper.cpp small.en on Metal). No
 * cloud, no API key, no audio leaves the machine. The CLI streams two
 * kinds of lines to stderr while recording:
 *   [dictate] LVL -23.4      — mic loudness in dB, drives the level meter
 *   [dictate] captured ...   — capture ended, transcription started
 * The transcript is the sole stdout line. Stop-to-text latency is the
 * whisper transcription time (~1-3s), during which the status row shows a
 * spinner.
 *
 * Requires: ~/.local/bin/dictate working (it downloads its own models on
 * first run) and mic permission for your terminal.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, isKeyRelease, isKeyRepeat } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// lifecycle events (listener hits, toggles, child exit with its generation).
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

const DICTATE_BIN = join(homedir(), ".local", "bin", "dictate");
// Hard wall-clock cap for one recording (the CLI's own TIMEOUT=180s wins
// normally; this kills a wedged process).
const HARD_TIMEOUT_MS = 200_000;

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so ctrl+space works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Inspect tui.focusedComponent to decide where the transcript goes.
// `focusedComponent` is declared private in the typings but is a plain
// runtime property — a benign peek, easily patched if pi internals change.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Mic level meter — a tiny rolling waveform rendered in the status row while
// recording, driven by the CLI's `[dictate] LVL <db>` stderr lines.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Map a dBFS value to one of PEAK_BLOCKS by clamping into the visible range. */
function dbToBlock(db: number): string {
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  return PEAK_BLOCKS[Math.floor(t * (PEAK_BLOCKS.length - 1))]!;
}

export default function (pi: ExtensionAPI) {
  let state: State = "idle";
  let proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let transcript = "";
  let stderrTail = "";
  let activeCtx: ExtensionContext | null = null;
  let flushed = false;
  let cancelled = false;
  let hardTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Session generation: incremented on every start and every cleanup. All
  // child event handlers capture the generation they belong to and no-op
  // when it's stale — otherwise a PREVIOUS session's late exit event (e.g.
  // one we killed on cancel) would finalize the CURRENT live session.
  let generation = 0;
  // Audio meter state. `meter` is a ring of recent levels (dB), newest at
  // index METER_CELLS-1. `currentLevel` is the most recent observed level —
  // the meter tick just samples it. Crucially we never reset it: empty ticks
  // re-render the last observed value, so the bars never drop to silence just
  // because no line happened to arrive in that 60ms window.
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(-100);
  let currentLevel = -100;

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(-100);
    currentLevel = -100;
    // Recording dot: a text glyph colored via the theme, not an emoji — emoji
    // presentation renders double-width in its own baked-in color and visually
    // shouts in the footer. `●` is the same dot pi's own docs use for
    // indicators; theme "error" gives the red.
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      setStatus(`${dot} ${meter.map(dbToBlock).join("")} listening…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    // Editor-like focus: the main chat editor, custom editors, and the
    // ctx.ui.editor()/input() popups (their inner pi-tui Editor hangs off
    // `.editor`). These accept a guaranteed direct setText append.
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    // Opaque component with input handling (quiz/ask selects, selectors):
    // we can type into it, but whether the text lands depends on its
    // internal focus (e.g. the quiz note field must be Tab-focused).
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const flush = () => {
    if (flushed || !activeCtx) return;
    flushed = true;
    if (cancelled) return; // discard transcript on cancel
    const text = transcript.replace(/\s+/g, " ").trim();
    if (!text) return;

    // Legacy fallback: no TUI handle captured (non-TUI mode / older pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + text);
      return;
    }

    // Resolve the target NOW — focus may have changed while dictating.
    const target = resolveTarget();
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      // Synthetic typing: the component routes the text wherever its
      // internal focus is. Text is plain printable words (whitespace
      // already normalized), so no keybindings/autocomplete can trigger.
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on
    // the clipboard and say so.
    try {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.end(text);
    } catch {}
    activeCtx.ui.notify("Dictation finished but no input field is focused — transcript copied to clipboard", "warning");
  };

  const cleanup = () => {
    generation++; // invalidate the dying session's event handlers
    dbg(`cleanup → gen ${generation}`);
    flush();
    stopSpinner();
    stopMeter();
    if (hardTimeout) {
      clearTimeout(hardTimeout);
      hardTimeout = null;
    }
    if (proc) {
      try {
        proc.kill("SIGTERM");
      } catch {}
      proc = null;
    }
    transcript = "";
    stderrTail = "";
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    flushed = false;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    activeCtx = ctx;
    transcript = "";
    stderrTail = "";
    flushed = false;
    cancelled = false;
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();

    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(DICTATE_BIN, [], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      ctx.ui.notify(`Failed to spawn ${DICTATE_BIN}: ${e.message}`, "error");
      cleanup();
      return;
    }
    proc = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (myGeneration !== generation) return;
      transcript += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (myGeneration !== generation) return;
      stderrTail = (stderrTail + chunk).slice(-1000);
      for (const line of chunk.split("\n")) {
        dbg(`stderr: ${line.trim()}`);
        const lvl = /^\[dictate\] LVL (-?\d+(?:\.\d+)?)/.exec(line.trim());
        if (lvl) {
          currentLevel = parseFloat(lvl[1]!);
          continue;
        }
        // Capture ended, the CLI is transcribing now — show the spinner.
        if (line.includes("[dictate] captured") && state === "recording") {
          stopMeter();
          startSpinner("finalizing…");
        }
      }
    });

    child.on("error", (err) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`dictate failed to start: ${err.message}`, "error");
      cleanup();
    });

    child.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale — a newer/ended session owns state
      dbg(`exit (gen ${myGeneration}, code ${code})`);
      // Natural end of a VAD-ended recording: the transcript is already on
      // stdout. A nonzero exit mid-recording is an error (e.g. no speech).
      if (code !== 0 && state === "recording") {
        const tail = stderrTail.trim().split("\n").slice(-2).join(" ");
        if (activeCtx) activeCtx.ui.notify(`Dictation failed${tail ? `: ${tail}` : ""}`, "warning");
      }
      cleanup();
    });

    // Safety net: kill a wedged process (should never fire — the CLI caps at
    // 180s and VAD-stops long before).
    hardTimeout = setTimeout(() => {
      if (state === "recording" || state === "stopping") {
        if (activeCtx) activeCtx.ui.notify("Dictation timed out", "error");
        cleanup();
      }
    }, HARD_TIMEOUT_MS);
  };

  /** Cancel dictation: discard any collected transcript and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    transcript = "";
    cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      // Pressed again while recording = cancel and discard (the pipeline
      // stops by itself ~1s after you stop talking, so there is no need
      // for a manual stop; F6 is the dedicated kill-switch).
      cancelDictation();
    }
    // Ignore presses during the "stopping" state — transcription is running.
  };

  // Global input listener: catches ctrl+space/F6 before ANY focused component,
  // which is what makes dictation work inside dialogs. Registered once the
  // TUI handle is captured (see session_start below).
  // ctrl+space arrives as NUL (\x00) in legacy terminals — space 0x20 & 0x1f
  // — which pi's parser maps to "ctrl+space" (unbound in pi's defaults);
  // F6 arrives as the escape sequence "ESC[17~". Terminal auto-repeat fires
  // repeatedly while a key is held, hence the debounce.
  let lastToggleAt = 0;
  const onGlobalInput = (data: string) => {
    // Kitty flag-2 terminals send press + REPEAT + RELEASE events, and input
    // listeners run BEFORE the TUI's release filter (that filter only guards
    // dispatch to the focused component). Without this guard a single
    // physical press toggles TWICE. Filter to press events only.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    const now = Date.now();
    if (matchesKey(data, Key.ctrl("space"))) {
      if (now - lastToggleAt < 450) return { consume: true };
      lastToggleAt = now;
      dbg(`ctrl+space (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, Key.f6)) {
      if (now - lastToggleAt < 450) return { consume: true };
      lastToggleAt = now;
      dbg(`F6 (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    if (ctx.mode !== "tui" || tuiHandle) return;
    // Capture the TUI handle via an invisible zero-height widget. The
    // listener function reference is stable, so even if the factory re-runs
    // the TUI's listener Set de-dupes it.
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (non-TUI modes, older pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(Key.ctrl("space"), {
    description: "Toggle voice dictation (local Whisper)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  // Dedicated cancel kill-switch. Dictation-only — a no-op when no dictation
  // is in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(Key.f6, {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });

  // ── /dictate — agent-in-the-loop flow ───────────────────────────────────
  pi.registerCommand("dictate", {
    description:
      "Dettare con il microfono (Whisper small.en locale) — la trascrizione diventa il tuo messaggio",
    handler: async (args, ctx) => {
      if (state !== "idle") {
        ctx.ui.notify("Dettatura già in corso — aspetta che finisca (option+n per annullare)", "warning");
        return;
      }
      const script = DICTATE_BIN;
      ctx.ui.setStatus("dictate", "🎤 Registrazione... fermati a fine frase (max 2 min)");
      try {
        const result = await pi.exec(script, [], { timeout: 200_000 });
        const text = result.stdout?.trim() ?? "";
        if (result.code !== 0 || !text) {
          const tail = (result.stderr ?? "").trim().split("\n").slice(-2).join(" ");
          ctx.ui.notify(`Dettato vuoto — non ho sentito nulla. Riprova. ${tail}`, "error");
          return;
        }
        const message = args?.trim() ? `${text}\n\n${args.trim()}` : text;
        await ctx.waitForIdle();
        pi.sendUserMessage(message);
      } catch (err) {
        ctx.ui.notify(`Dictation failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      } finally {
        ctx.ui.setStatus("dictate", undefined);
      }
    },
  });
}