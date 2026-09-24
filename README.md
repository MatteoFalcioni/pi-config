# pi-config

Configurazione personale del **pi coding agent** (`~/.pi`), versionata su GitHub. Include impostazioni, agenti, skill, prompt (comandi `/`), estensioni e riferimenti auth.

## Struttura

```
~/.pi/
├── agent/
│   ├── settings.json          # provider/modelli di default, pacchetti npm, tema
│   ├── models.json            # modelli personalizzati
│   ├── auth.json              # chiavi via Keychain/indirezione (nessun segreto in chiaro)
│   ├── mcp.json               # server MCP (GitHub Copilot, auth via `!gh auth token`)
│   ├── agents/                # sottogenti personalizzate
│   ├── skills/                # skill locali: pdf-compress, tts, web-debug, kimai-time-tracking
│   ├── prompts/               # comandi `/`: tts, pi-update-git
│   ├── extensions/            # estensioni: browser, kimai-tracker, tts-commands, ...
│   └── third-party-skills-lock.json   # registro skill esterne installate (~/.agents)
├── .gitignore
└── README.md
```

Non versionato (vedi `.gitignore`): `sessions/` (cronologia chat), `npm/` (pacchetti installati automaticamente), cache, profilo Chromium dell'estensione browser, il campione vocale `tars.wav` (dato biometrico), binari.

## Installazione da zero (Mac nuovo)

### 1. Node.js
Serve Node.js ≥ 22.19 (nvm consigliato):
```sh
nvm install 22 && nvm use 22     # oppure: brew install node
```

### 2. pi
```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```
Aggiornamenti: `pi update` (pi), `pi update --extensions` (pacchetti), `pi update --all` (entrambi).

### 3. Configurazione
```sh
git clone https://github.com/MatteoFalcioni/pi-config.git ~/.pi
```
Se `~/.pi` esiste già (pi usato prima): dentro `~/.pi` esegui
`git init -b main && git remote add origin <URL> && git pull origin main --allow-unrelated-histories`.

Al primo avvio pi installa automaticamente i pacchetti npm dichiarati in `settings.json` ("packages": ponytail, confluence-cli, pi-permission-system, pi-plan-mode, pi-subagents, pi-web-access, pi-mcp-adapter — serve internet). Le loro skill/estensioni vengono caricate da lì.

### 4. Segreti (macOS Keychain — mai nel repo)
I file `auth.json`/`mcp.json` non contengono chiavi: le leggono dal Keychain via indirezione `!command`. Su un Mac nuovo vanno ricreati:

```sh
# Chiave Azure Foundry (account esatto: matteofalcioni — è cablato in auth.json)
security add-generic-password -a matteofalcioni -s opencode-azure-foundry-key -w 'LA_CHIAVE'
# Token API Kimai
security add-generic-password -a "$USER" -s pi-kimai-key -w 'IL_TOKEN'
```
L'env `AZURE_OPENAI_BASE_URL` è già dentro `auth.json`, non serve nel profilo shell.

### 5. Dipendenze esterne

| Tool | Serve per | Installazione | Verifica |
|---|---|---|---|
| gh CLI | MCP GitHub (`!gh auth token`) | `brew install gh` + `gh auth login` | `gh auth status` |
| cloudflared | Kimai (Cloudflare Access SSO) | `brew install cloudflared` + `cloudflared access login https://time-reporting.axpo.com` | `cloudflared access token <url>` |
| ghostscript | skill pdf-compress | `brew install ghostscript` | `gs --version` |
| fd | ricerca file | `brew install fd` | `fd --version` |
| uv | gestione venv Python (tts, dictate) | `brew install uv` | `uv --version` |
| ffmpeg | audio (TTS) | `brew install ffmpeg` | `ffmpeg -version` |
| whisper-cpp | estensione dictate | `brew install whisper-cpp` | `whisper-cli --help` |
| Chromium (playwright) | estensione browser / web-debug | `cd ~/.pi/agent/extensions/browser && npm install && npx playwright install chromium` | `ls ~/Library/Caches/ms-playwright` |

### 6. Venv Python (Apple Silicon)

```sh
# TTS (mlx-audio) — PINNARE mlx a 0.31.2: le versioni ≥0.32 non compilano JIT su M5/macOS 26.1
uv venv ~/.local/venvs/tts --python 3.13
uv pip install --python ~/.local/venvs/tts/bin/python mlx-audio "mlx==0.31.2" "mlx-metal==0.31.2"
# modelli Qwen3-TTS (0.6B/1.7B) scaricati da HuggingFace al primo uso (~2.5+4.4 GB)

# dictate (whisper)
uv pip install --python ~/.local/venvs/dictate/bin/python sounddevice onnxruntime numpy
# modelli ggml-small.en + silero VAD scaricati al primo uso
```

### 7. Skill esterne
`microsoft-foundry` (e skill databricks, disabilitate) stanno in `~/.agents/skills`; il registro è in `third-party-skills-lock.json`.

## Uso quotidiano

- **`/pi-update-git`** — committa e pushta su `main` le modifiche a `~/.pi`.
- **`/reload`** — ricarica skill, estensioni, prompt, temi (dopo modifiche a `prompts/`, `skills/`, ...).
- **`/tts`** — sintesi vocale locale (TTS, persona TARS con `--tars`).
- **`/kimai`** (estensione) — time tracking Kimai.

Git sul config funziona come ovunque: `cd ~/.pi && git add -A && git commit -m "..." && git push`.