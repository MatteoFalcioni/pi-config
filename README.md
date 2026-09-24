# pi-config

Personal configuration for the **pi coding agent** (`~/.pi`), versioned on GitHub. Includes settings, custom agents, skills, prompts (`/` commands), extensions, and auth references.

## How versioning works (whitelist)

Everything under `~/.pi` is **live configuration** — it stays on disk and is never touched by git. Only what you explicitly whitelist ends up on GitHub:

- **`pi-git.json`** at the repo root lists what is tracked, by category: `skills`, `agents`, `prompts`, `extensions`, `files`.
- `README.md`, `pi-git.json` and the `/pi-git` extension itself are **always tracked**, whitelist or not — the repo must be able to restore its own tooling.
- The `/pi-git` extension handles everything; no manual git needed (see [Usage](#usage)).

## Structure

```
~/.pi/
├── agent/
│   ├── settings.json                # default provider/models, npm packages, theme
│   ├── models.json                  # custom models
│   ├── auth.json                    # keys via Keychain indirection (no plaintext secrets)
│   ├── mcp.json                     # MCP servers (GitHub Copilot, auth via `!gh auth token`)
│   ├── agents/                      # custom subagents
│   ├── skills/                      # local skills: pdf-compress, tts, web-debug, kimai-time-tracking
│   ├── prompts/                     # `/` commands: tts
│   ├── extensions/                  # extensions: browser, kimai-tracker, pi-git, tts-commands, ...
│   │   └── pi-git/                  # the /pi-git extension (index.ts + test.ts)
│   └── third-party-skills-lock.json # registry of externally installed skills (~/.agents)
├── pi-git.json                      # THE whitelist (managed via /pi-git --config)
├── .gitignore                       # junk exclusion (local, not tracked)
└── README.md
```

Never versioned (see `.gitignore`): `sessions/` (chat history), `npm/` (auto-installed packages), caches, the browser extension's Chromium profile, the `tars.wav` voice sample (biometric), binaries.

## Install from scratch (new Mac)

### 1. Node.js
Requires Node.js ≥ 22.19 (nvm recommended):
```sh
nvm install 22 && nvm use 22     # or: brew install node
```

### 2. pi
```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```
Updates: `pi update` (pi itself), `pi update --extensions` (packages), `pi update --all` (both).

### 3. Configuration
```sh
git clone https://github.com/MatteoFalcioni/pi-config.git ~/.pi
```
If `~/.pi` already exists (pi previously run): inside `~/.pi` run
`git init -b main && git remote add origin <URL> && git pull origin main --allow-unrelated-histories`.

On first launch, pi auto-installs the npm packages declared in `settings.json` ("packages": ponytail, confluence-cli, pi-permission-system, pi-plan-mode, pi-subagents, pi-web-access, pi-mcp-adapter — needs internet). Their skills/extensions load from there.

### 4. Secrets (macOS Keychain — never in the repo)
`auth.json`/`mcp.json` contain no keys: they read them from the Keychain via `!command` indirection. On a new Mac, recreate:

```sh
# Azure Foundry key (account must match: matteofalcioni — hardcoded in auth.json)
security add-generic-password -a matteofalcioni -s opencode-azure-foundry-key -w 'THE_KEY'
# Kimai API token
security add-generic-password -a "$USER" -s pi-kimai-key -w 'THE_TOKEN'
```
`AZURE_OPENAI_BASE_URL` already lives inside `auth.json` — nothing to add to your shell profile.

### 5. External dependencies

| Tool | Used for | Install | Verify |
|---|---|---|---|
| gh CLI | GitHub MCP (`!gh auth token`) | `brew install gh` + `gh auth login` | `gh auth status` |
| cloudflared | Kimai (Cloudflare Access SSO) | `brew install cloudflared` + `cloudflared access login https://time-reporting.axpo.com` | `cloudflared access token <url>` |
| ghostscript | pdf-compress skill | `brew install ghostscript` | `gs --version` |
| fd | file search | `brew install fd` | `fd --version` |
| uv | Python venv management (tts, dictate) | `brew install uv` | `uv --version` |
| ffmpeg | audio (TTS) | `brew install ffmpeg` | `ffmpeg -version` |
| whisper-cpp | dictate extension | `brew install whisper-cpp` | `whisper-cli --help` |
| Chromium (playwright) | browser extension / web-debug | `cd ~/.pi/agent/extensions/browser && npm install && npx playwright install chromium` | `ls ~/Library/Caches/ms-playwright` |

### 6. Python venvs (Apple Silicon)

```sh
# TTS (mlx-audio) — PIN mlx to 0.31.2: ≥0.32 fails JIT compilation on M5/macOS 26.1
uv venv ~/.local/venvs/tts --python 3.13
uv pip install --python ~/.local/venvs/tts/bin/python mlx-audio "mlx==0.31.2" "mlx-metal==0.31.2"
# Qwen3-TTS (0.6B/1.7B) weights download from HuggingFace on first use (~2.5+4.4 GB)

# dictate (whisper)
uv pip install --python ~/.local/venvs/dictate/bin/python sounddevice onnxruntime numpy
# ggml-small.en + silero VAD models download on first use
```

### 7. External skills
`microsoft-foundry` (and databricks skills, disabled) live in `~/.agents/skills`; the registry is `third-party-skills-lock.json`.

## Usage

- **`/pi-git --config`** — whitelist TUI: pick which skills/agents/prompts/extensions/files to track (written to `pi-git.json`). Toggle with Enter, back with Esc, "Save and exit" writes the file.
- **`/pi-git --update`** — syncs `main`: stages exactly the whitelist (+ always-tracked files), untracks anything no longer whitelisted, commits (`sync pi config (N files)`) and pushes. No-op if nothing changed.
- **`/reload`** — reload skills, extensions, prompts, themes (after editing `prompts/`, `skills/`, ...).
- **`/tts`** — local text-to-speech (TARS persona with `--tars`).
- **`/kimai`** (extension) — Kimai time tracking.

The `/pi-git` update logic is self-tested: run `PI_GIT_REPO=/tmp/scratch node agent/extensions/pi-git/test.ts` against a seeded scratch repo.