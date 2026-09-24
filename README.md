# pi-config

Whitelisted, versioned configuration for the [pi coding agent](https://pi.dev) (`~/.pi`), kept in sync with GitHub via the `/pi-git` command.

---

## Part 1 — Installing pi (from the official repo)

From the [pi coding agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md):

> Pi is a minimal, extensible AI agent for the terminal. Adapt Pi to your workflow, not the other way around.

Install the command-line interface with npm:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

This requires **Node.js 22.19 or newer**. Pi does not require dependency lifecycle scripts for a normal npm installation.

On macOS or Linux, you can instead use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

Full setup and usage: the [pi documentation](https://pi.dev/docs/latest) (also reachable in the installed package under `docs/`). Updating later: `pi update` (pi itself), `pi update --extensions` (packages), `pi update --all` (both).

---

## Part 2 — This repository

Everything under `~/.pi` is **live configuration**: it stays on disk and git never touches it unless whitelisted. Only what is listed in **`pi-git.json`** is pushed to GitHub, plus `README.md`, `pi-git.json` and the `/pi-git` extension itself, which are always tracked — the repo must be able to restore its own tooling.

Manage the whitelist with `/pi-git --config` (TUI: toggle entries with Enter, Esc goes back, "Save and exit" writes the manifest) and sync with `/pi-git --update` (stages exactly the whitelist, untracks anything no longer whitelisted, commits and pushes; no-op if nothing changed). The update logic is self-tested: `PI_GIT_REPO=/tmp/scratch node agent/extensions/pi-git/test.ts` against a seeded scratch repo.

### Structure

```
~/.pi/
├── agent/                       # pi's config directory (live)
│   ├── settings.json            # default provider/model, npm packages, theme, disabled skills
│   ├── models.json              # custom provider (azure-foundry-chat) and its models
│   ├── auth.json                # API key via Keychain indirection (no plaintext secrets)
│   ├── mcp.json                 # MCP servers (GitHub Copilot, auth via `!gh auth token`)
│   ├── web-search.json          # web_search provider settings (auto-summary workflow)
│   ├── APPEND_SYSTEM.md         # global behavior rules appended to every session
│   ├── agents/                  # custom subagents (4)
│   ├── skills/                  # local skills (3)
│   └── extensions/              # extensions (8 tracked)
├── pi-git.json                  # THE whitelist (managed via /pi-git --config)
└── README.md
```

Always excluded from this repo: `sessions/` (chat history), `npm/` (auto-installed packages), caches, the browser extension's Chromium profile, binaries.

### Models & provider

`models.json` defines one custom provider, **`azure-foundry-chat`** — an OpenAI-compatible endpoint on Azure Foundry (base URL `https://llm-4xa-sandbox.openai.azure.com/openai/v1`, static API key read from the macOS Keychain). Models available:

| Model | Context | Notes |
|---|---|---|
| DeepSeek-V4-Pro | 1M | reasoning; thinking: off/high/max |
| DeepSeek-V4-Flash | 1M | reasoning; thinking: off/high/max |
| DeepSeek-V4-Flash-0731 | 1M | reasoning; **default model** |
| Kimi-K2.6 | 200K | |
| Kimi-K2.7-Code | 200K | |
| Grok-4.6 | 1M | reasoning; supports reasoning effort (low→xhigh) |

Defaults in `settings.json`: provider `azure-foundry-chat`, model `DeepSeek-V4-Flash-0731`, thinking level `max`. Enabled models also include `azure-openai-responses/gpt-5-nano` and `gpt-5.6-terra`. API keys never appear in files: `auth.json` and `models.json` reference the Keychain via `!security find-generic-password …`, and the GitHub MCP token via `!gh auth token`.

### Skills (tracked)

| Skill | What it does |
|---|---|
| `pdf-compress` | Compresses PDFs locally with Ghostscript (quality presets, target size), no upload |
| `tts` | Local text-to-speech on Apple Silicon (mlx-audio), zero-shot voice cloning, TARS persona |
| `web-debug` | Drives a live page (DOM, storage, network, console) with browser tools to debug frontend issues |

### Agents (tracked)

| Agent | What it does |
|---|---|
| `Explore.md` | Generic exploration agent (currently `enabled: false`) |
| `codebase-scout` | Fast read-only codebase recon (files, patterns, architecture) |
| `deep-researcher` | GenAI research and fact-checking analyst with confidence-tagged reports |
| `worker` | General-purpose worker that reads, writes, and edits code |

### Extensions (tracked)

| Extension | What it does |
|---|---|
| `ask.ts` | `/ask` — interactive picker for user questions |
| `clip.ts` | `/clip` — copies text / last assistant reply to the macOS clipboard |
| `dictate.ts` | `/dictate` — fully local voice dictation (whisper-cpp) |
| `inspect-image.ts` | `inspect_image` — routes images to a vision model for non-vision models |
| `browser/` | Playwright-driven headless Chromium (`browser_*` tools) for live-page debugging |
| `pi-permission-system/` | Permission gating (config: yoloMode on, permission review log) |
| `tts-commands.ts` | `/speak` — direct TTS command, no LLM round trip |
| `pi-git/` | `/pi-git` — the whitelist TUI and sync command this repo runs on |

### Installed packages (auto-installed by pi from `settings.json` "packages")

- `npm:pi-web-access` — web access for pi
- `npm:pi-mcp-adapter` — MCP server support (reads `mcp.json`, lazy connects)
- `npm:@dietrichgebert/ponytail` — lazy-mode skills (`ponytail`, `-audit`, `-debt`, `-gain`, `-help`, `-review`) + extension
- `npm:@gotgenes/pi-permission-system` — permission system
- `npm:confluence-cli` — installed with its extension and skill **explicitly disabled**
- `npm:@narumitw/pi-plan-mode` — plan-mode workflow
- `npm:@tintinweb/pi-subagents` — subagent orchestration

Disabled via `settings.json`: the ~27 databricks skills, `langchain-docs`, the `confluence` skill/extension.

### MCP servers (`mcp.json`)

- **github** — GitHub Copilot MCP (`https://api.githubcopilot.com/mcp/`), auth via `!gh auth token` (requires `gh` CLI logged in).

### Global behavior (`APPEND_SYSTEM.md`)

Be concise · explain technical concepts in plain English (no jargon) · delegate to subagents when it helps · the user is Matteo.

---

## Part 3 — Restoring this setup on a new Mac

### 1. Install pi (Part 1), then clone

```sh
git clone https://github.com/MatteoFalcioni/pi-config.git ~/.pi
```

If `~/.pi` exists (pi was run before): inside `~/.pi` run
`git init -b main && git remote add origin <URL> && git pull origin main --allow-unrelated-histories`.

On first launch pi auto-installs the npm packages declared in `settings.json` (needs internet). Their skills/extensions load from there.

### 2. Secrets (macOS Keychain — never in the repo)

```sh
# Azure Foundry key (account must match: matteofalcioni — hardcoded in auth.json)
security add-generic-password -a matteofalcioni -s opencode-azure-foundry-key -w 'THE_KEY'
```

`AZURE_OPENAI_BASE_URL` already lives inside `models.json`/`auth.json` — nothing to add to your shell profile.

### 3. External dependencies

| Tool | Used for | Install | Verify |
|---|---|---|---|
| gh CLI | GitHub MCP (`!gh auth token`) | `brew install gh` + `gh auth login` | `gh auth status` |
| ghostscript | pdf-compress skill | `brew install ghostscript` | `gs --version` |
| fd | file search | `brew install fd` | `fd --version` |
| uv | Python venv management (tts, dictate) | `brew install uv` | `uv --version` |
| ffmpeg | audio (TTS) | `brew install ffmpeg` | `ffmpeg -version` |
| whisper-cpp | dictate extension | `brew install whisper-cpp` | `whisper-cli --help` |
| Chromium (playwright) | browser extension / web-debug | `cd ~/.pi/agent/extensions/browser && npm install && npx playwright install chromium` | `ls ~/Library/Caches/ms-playwright` |

### 4. Python venvs (Apple Silicon)

```sh
# TTS (mlx-audio) — PIN mlx to 0.31.2: ≥0.32 fails JIT on M5/macOS 26.1
uv venv ~/.local/venvs/tts --python 3.13
uv pip install --python ~/.local/venvs/tts/bin/python mlx-audio "mlx==0.31.2" "mlx-metal==0.31.2"
# Qwen3-TTS (0.6B/1.7B) weights download from HuggingFace on first use (~2.5+4.4 GB)

# dictate (whisper)
uv pip install --python ~/.local/venvs/dictate/bin/python sounddevice onnxruntime numpy
# ggml-small.en + silero VAD models download on first use
```

## Daily use
- **`/pi-git --config`** — whitelist TUI; **`/pi-git --update`** — commit + push `main`.
- **`/reload`** — reload skills, extensions, prompts, themes after editing config.
- **`/ask`**, **`/clip`**, **`/dictate`**, **`/speak`** — user picker, clipboard, dictation, TTS (commands from tracked extensions).

No manual git: `/pi-git --update` stages the whitelist, untracks what left it, commits (`sync pi config (N files)`) and pushes.