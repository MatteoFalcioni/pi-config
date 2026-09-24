---
name: tts
description: Local text-to-speech on Apple Silicon using Qwen3-TTS (0.6B/1.7B) via mlx-audio on the Metal GPU. Use when the user wants spoken/audio output, text read aloud, voice synthesis, or zero-shot voice cloning from a reference clip. Fully offline — no API keys.
---

# TTS (Qwen3-TTS local speech synthesis)

Synthesizes speech from text on this Mac (Apple M5, 24 GB) using
`Qwen/Qwen3-TTS-12Hz-0.6B-Base` (default) or the 1.7B model, running locally on
Metal via `mlx-audio`. Supports zero-shot voice cloning from a ~3 s reference
clip. Model is cached in `~/.cache/huggingface` (no download needed after first run).

## Setup (already done — for reference / re-creation)

```bash
brew install ffmpeg portaudio
uv venv ~/.local/venvs/tts --python 3.13
uv pip install --python ~/.local/venvs/tts/bin/python mlx-audio "mlx==0.31.2" "mlx-metal==0.31.2"
```

> **CRITICAL: keep `mlx` pinned to 0.31.2.** mlx >= 0.32 JIT-compiles NAX
> `steel_gemm` kernels that fail to compile on this M5 + macOS 26.1
> (`unsupported deferred-static-alloca-size`). Do not "fix" any MLX-related
> errors by upgrading mlx.

## Usage

Always run through the pinned venv:

```bash
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py "text to speak"
```

Key options (see `--help` for all):

| Flag | Purpose |
|---|---|
| `--out PATH.wav` | Output file (default `~/tts_output/tts_<timestamp>.wav`) |
| `--no-play` | Disable automatic playback (default: audio plays after generating) |
| `--temperature` | 0.8 default (faithful but stable; lower = more deterministic, <0.5 may repetition-loop) |
| `--ref-audio clip.wav` | Zero-shot voice clone from reference clip (~3 s, clean, 24 kHz mono) |
| `--ref-text "..."` | Transcript of the reference clip — improves cloning fidelity |
| `--lang it` | Language hint: `auto, en, zh, es, it, pt, de, fr, ja, ko, ru` |
| `--model 1.7b` | Higher quality broadcast-level prosody (+~2 GB; model downloads on first use) |
| `--voice NAME` | Named voice preset (`tars`), CustomVoice speaker, o `none` = voce neutra di default |
| `--daemon` | Dopo la run (fredda), spawna un daemon warm staccato che serve le chiamate successive con lo stesso `--model`/`--voice` da RAM (~1 s l'una). Auto-exit dopo `--idle-timeout` di inattività |
| `--shutdown` | Ferma tutti i daemon warm (senza caricare il modello) |
| `--idle-timeout N` | Secondi di idle prima che il daemon warm si chiuda da solo (default 120) |

Examples:

```bash
# basic — generates AND plays by default
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py "Hello from Qwen three TTS" --out ~/tts_output/hello.wav

# generate without playing
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py "This is a test" --no-play

# clone a voice
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py \
  "Howdy, this is my cloned voice!" --ref-audio ~/Desktop/my_voice.wav --ref-text "The reference transcript"

# TARS voice preset
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py "Hello Coop." --voice tars

# other language
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py "Ciao, come va?" --lang it

# warm daemon: 1st call cold (~3.7s) + spawns a detached daemon; later calls are warm (~1s)
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py --daemon --model 1.7b --voice tars "warm up"
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py --model 1.7b --voice tars "second call hits the warm daemon"
~/.local/venvs/tts/bin/python ~/.pi/agent/skills/tts/scripts/tts.py --shutdown   # stop warm daemon(s) now (or they self-exit after 120s idle)
```

Text can also be piped via stdin.

## Warm daemon (`--daemon`)

Facoltativo — evita il cold start (~3.5 s di load modello) quando si fanno più chiamate ravvicinate (es. stesso modello/voce per un po' di fila). Comportamento:

- **Prima chiamata `--daemon`**: run fredda normale, poi spawna un figlio staccato (`--serve`) che ricarica il modello in background e ascolta su un socket Unix. La chiamata successiva (anche **senza** `--daemon`) la trova calda: ~1 s totale, nessun `model loaded`.
- **Un daemon per combinazione (model, voce)**. File in `~/.tts/` (`.sock`, `.pid`, `.log`).
- **Auto-terminante**: esce da solo dopo `--idle-timeout` (default 120 s) senza richieste e cancella socket+pid. Nessun processo residente oltre quella finestra.
- **RAM**: ~5-6 GB (1.7B) trattenuti solo durante la finestra di 2 minuti dopo l'ultima chiamata; ~0% CPU a riposo.
- **Fallback**: daemon morto/stale → le chiamate tornano al cold start, mai più lente di prima. Race di ~2-3 s dopo lo spawn: quelle chiamate fanno cold start.
- **`--shutdown`**: ferma tutti i daemon warm (graceful via socket, SIGTERM/SIGKILL fallback) e rimuove i file. Non carica il modello.

## `/tts` chat command

A prompt template in `~/.pi/agent/prompts/tts.md` registers the `/tts`
command: `/tts <text-or-task>`. It loads this skill and speaks the given text,
or performs a task first (e.g. `/tts riassumi X e leggilo`) and then reads the
result aloud. It also parses `--tars` (TARS voice + persona, see above), `--humor N`
(0–100 humor level, default 75), `--daemon` (keep the model warm: first
call cold, later ones ~1 s) and `--shutdown` (stop any warm daemon, no
synthesis). Playback is on by default; use `--no-play` when the user
doesn't want sound.

## Direct commands (no LLM round trip)

Two independent extensions in `~/.pi/agent/extensions/` (hot-reload with `/reload`):

- `clip.ts` → **`/clip [text]`** — standalone clipboard utility: copies text to
  the macOS clipboard; without text, copies the last assistant reply. No TTS
  dependency, usable for anything.
- `tts-commands.ts` → **`/speak [text] [flags]`** — captures text (args →
  last assistant reply → clipboard), copies it to the clipboard as a side
  effect, and speaks it with the script. No manual `/clip` needed.
  Flags passthrough: `--model 0.6b|1.7b` (small is the default), `--lang xx`,
  `--voice name`, `--no-play`. Cap: 4000 chars.

Typical flow: ask pi for a summary → `/speak` (it clips the reply and reads it).

## Named voices (presets)

Named voice presets live in `assets/voices.json`, with reference audio in
`assets/voices/`. A preset sets the reference + tuning (temperature,
repetition penalty, default language). Explicit CLI flags override preset
values. Default voice is the model's neutral voice (no preset).

### `--voice tars` — TARS persona (from Interstellar)

When the TARS voice is used, act as **TARS** in the spoken text:

- Address the user as **"Coop"** (Cooper). Never use their real name.
- Machine-like, deadpan, efficient delivery; short sentences.
- **Humor setting** (default 75%): the user can ask for `--humor N` (0–100).
  Scale the wittiness/ironic remarks accordingly: 0 = literal and dry,
  50 = light dry sarcasm, 100 = a joke in most sentences. Keep it TARS-style:
  self-aware, self-deprecating about being a robot, deadpan "humor".
- The humor is written by the LLM into the text (do not change audio tuning
  for it); the TARS audio preset stays: temp 0.2, rep-penalty 1.5, English.
- If the user writes in another language, still keep the TARS personality but
  pass `--lang` matching the text.

## Typical flow for an agent turn

1. Build the utterance string (include punctuation for natural prosody).
2. If the user has a preferred voice and a reference clip is available, pass
   `--ref-audio` (+ `--ref-text` when known). Otherwise use the default voice.
3. `--play` only when the user asked to hear it; otherwise just save and report
   the path.
4. Output dir for anything saved: `~/tts_output/`.

## Performance notes (M5, verified)

- 0.6B: ~0.5× real-time (5.8 s to synthesize 11.3 s), peak ~6 GB, model load ~2 s.
- 1.7B: higher quality, needs ~2 GB more memory; first load downloads ~4.4 GB.
- Use `--max-tokens` if a single segment hits the default 4096 cap.

## Troubleshooting

- **`Unable to load kernel steel_gemm...`**: mlx got upgraded. Re-pin
  `mlx==0.31.2 mlx-metal==0.31.2` (and reinstall into the venv).
- **`RepositoryNotFoundError` / slow "Fetching N files"**: HF download was
  interrupted; re-run once (downloads resume, ~2.5 GB total for 0.6B).
- **Model doesn't exist error**: never use `mlx-community/Qwen3-TTS-*` ids —
  they are gone; use the official `Qwen/Qwen3-TTS-12Hz-*` repos.
- **No sound with `--play`**: `portaudio` must be installed (`brew install portaudio`);
  playback uses `afplay` otherwise.
- **Integer-sample buzzing or robotic timbre**: only happens if weights were
  quantized to 4-bit — the base repo is bf16, keep it that way.