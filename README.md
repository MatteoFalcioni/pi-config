# pi-config

Whitelisted, versioned configuration for the [pi coding agent](https://pi.dev) (`~/.pi`), kept in sync with GitHub via the `/pi-git` command.

**The easiest way to install: give an agent this repository's link and tell it to configure Pi for you** — the agent walks you through the installation step by step (see Part 3).

---

## Part 1 — Installing pi (from the official repo)

Pi runs on macOS, Linux and Windows (native or WSL). Follow the [official quickstart](https://pi.dev/docs/latest/quickstart) for more detail.

**macOS/Linux (including WSL):** use the official installer in your terminal. It can offer to install Node.js and npm if they are missing. On WSL, run it *inside your Linux distribution*, not in PowerShell:

```sh
curl -fsSL https://pi.dev/install.sh | sh
```

**Native Windows:** install [Node.js 22.19 or newer](https://nodejs.org/en/download) (with npm) and [Git for Windows](https://git-scm.com/download/win) (Pi uses Git Bash for shell commands). Then run in PowerShell:

```powershell
npm.cmd install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Prefer npm on macOS or Linux? With Node.js 22.19+ and npm installed, run `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` instead. See the [Windows setup guide](https://pi.dev/docs/latest/windows) for native Windows shell options.

**Restoring this repo?** Clone it *before* using the installer or starting Pi, since either can create `$HOME/.pi` (see Part 3).

On any platform, check the installation with `pi --version`, then open a terminal in the folder you want Pi to work in and run `pi`. If PowerShell blocks `.ps1` scripts, use `pi.cmd` instead. For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key.

Full setup and usage: the [pi documentation](https://pi.dev/docs/latest) (also reachable in the installed package under `docs/`). Updating later: `pi update` (pi itself), `pi update --extensions` (packages), `pi update --all` (both).

---

## Part 2 — This repository

Everything under `~/.pi` is **live configuration**: it stays on disk and git only touches what is not in **`.gitignore`** — that file is the whitelist. `README.md`, `pyproject.toml`, `uv.lock`, `.gitignore` and the `/pi-git` extension itself are always part of the repo (they aren't ignored), so the repo can restore its own tooling.

Manage the whitelist with `/pi-git --config` (TUI: browse categories, Enter toggles a file between tracked ✓ / ignored ✗, Esc goes back — every choice writes `.gitignore`) and sync with:

- `/pi-git --update` — lists **new** local files in a TUI (toggle `track`/`ignore`, Esc to proceed), stages everything with `git add -A`, then delegates README regeneration to pi based on the staged changes.
- `/pi-git --push` — re-stages, asks for confirmation **only if `README.md` changed** (include it or skip it), then commits and pushes.

The logic is self-tested: `npm root -g` for `NODE_PATH`, `PI_GIT_REPO=/tmp/scratch`, then `node agent/extensions/pi-git/test.ts` against a seeded scratch repo.

### Structure (tracked files only)

```
~/.pi/
├── agent/                       # pi's config directory (live)
│   ├── settings.json            # default provider/model, npm packages, theme, disabled skills
│   ├── models.json              # custom provider (azure-foundry-chat) and its models
│   ├── auth.json                # API key via Keychain or environment (no plaintext secrets)
│   ├── mcp.json                 # MCP servers (GitHub Copilot, auth via `!gh auth token`)
│   ├── web-search.json          # web_search provider settings (auto-summary workflow)
│   ├── APPEND_SYSTEM.md         # global behavior rules appended to every session
│   ├── crashes.json             # pi crash log (auto-written, prune as it grows)
│   ├── agents/                  # custom subagents (4)
│   ├── skills/                  # local skills (2)
│   └── extensions/              # extensions (8)
├── .gitignore                   # THE whitelist (managed via /pi-git --config)
└── README.md
```

Always excluded from this repo: `sessions/` (chat history), `npm/` (auto-installed packages), `agent/install/` (Pi installer files), caches, the browser extension's Chromium profile, binaries — plus anything you mark as ignored via `/pi-git`, which lands under the `# user excludes (managed via /pi-git)` section of `.gitignore`.

### Models & provider

`models.json` defines one custom provider, **`azure-foundry-chat`** — an OpenAI-compatible endpoint on Azure Foundry (base URL `https://llm-4xa-sandbox.openai.azure.com/openai/v1`, API key from the macOS Keychain or an environment variable). Models available:

| Model | Context | Notes |
|---|---|---|
| DeepSeek-V4-Pro | 1M | reasoning; thinking: off/high/max |
| DeepSeek-V4-Flash | 1M | reasoning; thinking: off/high/max |
| DeepSeek-V4-Flash-0731 | 1M | reasoning; **default model** |
| Kimi-K2.6 | 200K | |
| Kimi-K2.7-Code | 200K | |
| Grok-4.6 | 1M | reasoning; supports reasoning effort (low→xhigh) |
| GPT-6 Sol | 1M | reasoning; thinking: off/high/max — default thinking: max |

Defaults in `settings.json`: provider `azure-foundry-chat`, model `DeepSeek-V4-Flash-0731`, thinking level `max`. Enabled models also include `azure-openai-responses/gpt-5-nano`, `gpt-5.6-terra`, and `azure-foundry-chat/gpt-6-sol` (thinking pinned to `max`). No plaintext API keys are committed: `auth.json` and `models.json` read the macOS Keychain via `!security find-generic-password …` or a per-process environment variable, and the GitHub MCP token via `!gh auth token`.

> ⚠️ **This provider requires real Azure Foundry credentials**: the API key is read from the macOS Keychain (`pi-az-foundry-key`) or, outside macOS, from the `AZURE_OPENAI_API_KEY` environment variable (see Part 3). Do not invent or fabricate them — if the credentials are missing, stop and ask the owner for the key.

### Skills (2)

| Skill | What it does |
|---|---|
| `pdf-compress` | Compresses PDFs locally with Ghostscript (quality presets, target size), no upload |
| `web-debug` | Drives a live page (DOM, storage, network, console) with browser tools to debug frontend issues |

### Agents (4)

| Agent | What it does |
|---|---|
| `Explore.md` | Generic exploration agent (currently `enabled: false`) |
| `codebase-scout` | Fast read-only codebase recon (files, patterns, architecture) |
| `deep-researcher` | GenAI research and fact-checking analyst with confidence-tagged reports |
| `worker` | General-purpose worker that reads, writes, and edits code |

### Extensions (8) and their commands/tools

| Extension | What it does |
|---|---|
| `ask.ts` | `/ask` — interactive picker for user questions |
| `clip.ts` | `/clip` — copies text / last assistant reply to the macOS clipboard |
| `dictate.ts` | `/dictate` — fully local voice dictation (whisper-cpp) |
| `inspect-image.ts` | `inspect_image` — routes images to a vision model for non-vision models |
| `browser/` | Playwright-driven headless Chromium (`browser_*` tools) for live-page debugging |
| `pi-permission-system/` | Permission gating (config: yoloMode on, permission review log) |
| `pi-git/` | `/pi-git` — `.gitignore`-based sync: `--config` TUI (track/ignore), `--update` (new-file review + README regeneration), `--push` (README confirm + commit/push) |
| `pi-logo.ts` | `/builtin-header` — restores pi's built-in header (three-colour ASCII mark) |

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

Be concise · explain technical concepts in plain English (no jargon) · delegate to subagents when it helps

---

## Part 3 — Restoring this setup on macOS, Linux or Windows

> **Installing agent:** work through this section in order. Before installing anything, tell the user what you're about to install and why, and wait for their go-ahead. Only install the extra tools for features they want.

### 1. Clone, then install pi (Part 1)

Install [Git](https://git-scm.com/downloads) if needed (on native Windows, Git for Windows also provides Pi's Bash). **Before running Pi or its installer**, use a macOS/Linux/WSL shell or Windows PowerShell to clone:

```sh
git clone https://github.com/MatteoFalcioni/pi-config.git "$HOME/.pi"
```

If `$HOME/.pi` already exists, don't clone over it: back it up and migrate its sessions, settings, credentials and any existing Pi installation deliberately. Don't pull unrelated histories into live configuration.

Now install Pi using Part 1. On first launch Pi installs the npm packages declared in `settings.json` (needs internet and npm). Their skills/extensions load from there.

### 2. Extra tools (only for features you use)

| Tool | Needed for | Install |
|---|---|---|
| [GitHub CLI (`gh`)](https://github.com/cli/cli#installation) | GitHub MCP auth (`!gh auth token`) | Follow your OS instructions, then run `gh auth login` |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | macOS dictation (step 4) | Follow its install guide; on macOS, `brew install uv` also works |

### 3. Optional extensions (offer, install on approval)

| Tool | Install | Needed for |
|---|---|---|
| [Ghostscript](https://www.ghostscript.com/releases/gsdnld.html) | `brew install ghostscript` | pdf-compress skill (macOS-only script) |
| whisper-cpp (macOS only) | `brew install whisper-cpp` | dictate extension |
| Chromium (Playwright) | In `$HOME/.pi/agent/extensions/browser`, run `npm install`, then `npx playwright install chromium` (PowerShell: `npm.cmd` / `npx.cmd`) | browser extension / web-debug skill |

### 4. macOS-only dictation dependencies

Only if using `/dictate`, from this repo's root:

```sh
cd "$HOME/.pi"
uv sync --group dictate     # creates .venv from pyproject.toml + uv.lock
```

The macOS dictation backend (`~/.local/bin/dictate`) is **not included** in this repo; `uv sync` alone does not enable it. `/clip` needs macOS (`pbcopy`), and the PDF-compress script uses macOS `stat`. None of these extras is required to run Pi on Linux or Windows.

### 5. Secrets — never in the repo or shell profiles

The default Azure models need the owner's real API key. **Installing agent:** have the user enter it on their own machine, never in this chat. Wait for confirmation before continuing. This config reads `pi-az-foundry-key` from macOS Keychain; on Linux/Windows, it reads `AZURE_OPENAI_API_KEY`. The functions below fetch the key from encrypted storage when Pi starts instead of saving plaintext in a profile or exporting it for the whole shell session.

**macOS — Keychain.** Run this in your own terminal; the final `-w` prompts for the key without putting it in shell history:

```sh
security add-generic-password -a "$USER" -s pi-az-foundry-key -U -w
```

`auth.json` and `models.json` already read this item directly. Optionally, to make credentials available to Pi integrations, add the **existing** `pi()` function from this machine's `~/.zshrc` to your own `~/.zshrc` (keep only lines for Keychain items you actually have):

```zsh
pi() {
  PI_KIMAI_KEY=$(security find-generic-password -a "$USER" -s pi-kimai-key -w) \
  AZURE_FOUNDRY_API_KEY=$(security find-generic-password -a "$USER" -s pi-az-foundry-key -w) \
  OPENROUTER_API_KEY=$(security find-generic-password -a "$USER" -s openrouter -w) \
  command pi "$@"
}
```

The Azure models work without this optional function; it passes additional keys to Pi and its integrations only while Pi runs. Open a new terminal after editing `~/.zshrc`.

**Linux/WSL — [pass](https://www.passwordstore.org/) + GnuPG.** Install and initialize `pass` with your GPG key using its linked instructions, then store the key (the command prompts; do not type the key as an argument):

```sh
pass insert pi-az-foundry-key
```

Add to `~/.bashrc` (or `~/.zshrc` if using zsh), then open a new terminal:

```sh
pi() {
  local key
  key=$(pass show pi-az-foundry-key) || return 1
  AZURE_OPENAI_API_KEY="$key" command pi "$@"
}
```

**Native Windows — Windows DPAPI.** In PowerShell, store an encrypted credential **outside this repo**; enter the Azure key as the password (the username `pi` is just a label):

```powershell
Get-Credential -UserName pi -Message 'Azure Foundry API key' | Export-Clixml "$env:LOCALAPPDATA\pi-az-foundry-key.xml"
```

Add this function to your PowerShell profile (`$PROFILE`), then open a new PowerShell window:

```powershell
function pi {
  $credential = Import-Clixml "$env:LOCALAPPDATA\pi-az-foundry-key.xml" -ErrorAction Stop
  $env:AZURE_OPENAI_API_KEY = $credential.GetNetworkCredential().Password
  try { & pi.cmd @args }
  finally { Remove-Item Env:AZURE_OPENAI_API_KEY -ErrorAction SilentlyContinue }
}
```

The [encrypted credential](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/export-clixml) can be decrypted only by the same Windows user on the same machine; repeat setup on a new machine. If your execution policy blocks PowerShell profiles, define the function in each session instead of bypassing an organization policy.

These methods protect keys *at rest* and keep plaintext out of shell history and profiles; while Pi runs, its extensions and child processes can still access credentials you give it ([Pi security guide](https://pi.dev/docs/latest/security)). `AZURE_OPENAI_BASE_URL` is already set in `models.json`/`auth.json`.
