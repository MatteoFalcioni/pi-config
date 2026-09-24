/**
 * /pi-git — versiona la configurazione pi su GitHub con una whitelist.
 *
 *   /pi-git --config  TUI: scegli skill/agenti/prompt/estensioni/file da tracciare
 *   /pi-git --update  committa e pushta su main solo ciò che è in pi-git.json
 *   /pi-git --readme  riallinea il README ai cambiamenti locali (delega a pi)
 *
 * La whitelist vive in ~/.pi/pi-git.json. README.md, pi-git.json e questo tool
 * sono sempre tracciati, whitelist o no: la repo deve saper ripararsi da sola.
 * La logica di update è esportata e coperta da test.ts (scratch repo via PI_GIT_REPO).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileP = promisify(execFile);

const REPO = process.env.PI_GIT_REPO || `${os.homedir()}/.pi`;
const AGENT = `${REPO}/agent`;
const MANIFEST = `${REPO}/pi-git.json`;
const BRANCH = "main";
const REMOTE = "origin";

export type Manifest = {
	skills: string[];
	agents: string[];
	prompts: string[];
	extensions: string[];
	files: string[];
};

export const DEFAULT_MANIFEST: Manifest = {
	skills: [],
	agents: [],
	prompts: [],
	extensions: [],
	files: [],
};

// Sempre tracciati, whitelist o no.
const ALWAYS = ["README.md", "pi-git.json", "pyproject.toml", "uv.lock", "agent/extensions/pi-git/"];

interface Category {
	key: keyof Manifest;
	label: string;
	dir: string; // sotto AGENT
	kind: "dirs" | "files" | "both";
	resolve: (name: string) => string; // path repo-relativo
}

// File di stato macchina: mai proposti in lista (sarebbero comunque ignorati da git).
const STATE_FILES = new Set([
	"trust.json",
	"mcp-cache.json",
	"models-store.json",
	"cloudflare-gateway-ca.pem",
]);

const CATEGORIES: Category[] = [
	{ key: "skills", label: "Skill", dir: "skills", kind: "dirs", resolve: (n) => `agent/skills/${n}` },
	{ key: "agents", label: "Agenti", dir: "agents", kind: "files", resolve: (n) => `agent/agents/${n}` },
	{ key: "prompts", label: "Prompt", dir: "prompts", kind: "files", resolve: (n) => `agent/prompts/${n}` },
	{ key: "extensions", label: "Estensioni", dir: "extensions", kind: "both", resolve: (n) => `agent/extensions/${n}` },
	{ key: "files", label: "File config", dir: ".", kind: "files", resolve: (n) => `agent/${n}` },
];

export async function git(
	args: string[],
	opts: { cwd?: string; timeout?: number } = {},
): Promise<{ ok: boolean; out: string; err: string }> {
	try {
		const { stdout, stderr } = await execFileP("git", args, {
			cwd: opts.cwd ?? REPO,
			timeout: opts.timeout ?? 120_000,
			maxBuffer: 16 * 1024 * 1024,
		});
		return { ok: true, out: stdout.trim(), err: stderr.trim() };
	} catch (e: any) {
		return { ok: false, out: (e?.stdout ?? "").trim(), err: (e?.stderr ?? "").trim() || e?.message };
	}
}

export function loadManifest(): Manifest | null {
	try {
		return { ...DEFAULT_MANIFEST, ...JSON.parse(fs.readFileSync(MANIFEST, "utf8")) };
	} catch {
		return null;
	}
}

export function saveManifest(m: Manifest): void {
	fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

function listEntries(cat: Category): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(`${AGENT}/${cat.dir}`, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => !e.name.startsWith("."))
		.filter((e) => (cat.kind === "dirs" ? e.isDirectory() : cat.kind === "files" ? e.isFile() : true))
		.filter((e) => !(cat.key === "files" && STATE_FILES.has(e.name)))
		.filter((e) => cat.key !== "files" || /\.(json|md)$/.test(e.name))
		.map((e) => e.name)
		.sort();
}

export async function runUpdate(): Promise<string> {
	const m = loadManifest();
	if (!m) return "Manca pi-git.json — prima /pi-git --config";

	// Normalizza gli slash finali: il confronto di rimozione aggiunge "/" al path.
	const wanted: string[] = [...ALWAYS, ...CATEGORIES.flatMap((c) => m[c.key].map(c.resolve))].map((p) =>
		p.replace(/\/+$/, ""),
	);
	const warnings: string[] = [];

	for (const p of wanted) {
		const r = await git(["add", "--", p]);
		if (!r.ok) warnings.push(`ignorato: ${p} (${r.err.split("\n")[0]})`);
	}

	const ls = await git(["ls-files"]);
	const tracked = ls.ok ? ls.out.split("\n").filter(Boolean) : [];
	const toRemove = tracked.filter((t) => !wanted.some((w) => t === w || t.startsWith(`${w}/`)));
	for (const t of toRemove) {
		await git(["rm", "-r", "--cached", "--quiet", "--", t]);
	}

	const diff = await git(["diff", "--cached", "--name-only"]);
	const changed = diff.ok ? diff.out.split("\n").filter(Boolean) : [];
	if (!changed.length) {
		return "Già sincronizzato: nessuna modifica in whitelist." + (warnings.length ? `\n${warnings.join("\n")}` : "");
	}

	const commit = await git(["commit", "-m", `sync pi config (${changed.length} files)`]);
	if (!commit.ok) return `Commit fallito: ${commit.err}`;

	const push = await git(["push", REMOTE, BRANCH], { timeout: 300_000 });
	if (!push.ok) return `Commit ok, ma push fallito: ${push.err}`;

	const shown = changed.map((p) => p.replace(/^agent\//, "")).slice(0, 4).join(", ");
	const hash = commit.out.match(/\b[0-9a-f]{7,}\b/)?.[0] ?? "?";
	const summary = `Pushato ${hash} (${BRANCH}): ${shown}${changed.length > 4 ? ` +${changed.length - 4}` : ""}`;
	return warnings.length ? `${summary}\n${warnings.join("\n")}` : summary;
}

export function buildReadmeMessage(status: string, tracked: string[]): string {
	return (
		`[pi-git] Rigenera ~/.pi/README.md per riflettere lo stato CORRENTE della configurazione.\n\n` +
		`La repo è ~/.pi (whitelist in pi-git.json). Regole rigide:\n` +
		`- Documenta SOLO i file tracciati: la lista qui sotto è la verità. Se un path non è tra questi (e non è README.md/pi-git.json/pyproject.toml/uv.lock/agent/extensions/pi-git), NON menzionarlo mai.\n` +
		`- Le righe \`??\` nello status sono file locali NON tracciati: ignorale a meno che il path non compaia in pi-git.json.\n` +
		`- Tutto in inglese, conciso, con tabelle.\n` +
		`- Mantieni INALTERATI: la sezione "Part 1 — Installing pi (from the official repo)", la riga bold "The easiest way to install…" sotto l'intro, il disclaimer credenziali Azure (⚠️) nella sezione modelli, e la sezione "5. Secrets".\n` +
		`- Non aggiungere né rimuovere sezioni: aggiorna solo il contenuto di quelle esistenti per riflettere i cambiamenti.\n` +
		`\nCambiamenti dalla view git (git status --porcelain):\n` +
		(status || "(nessuno)") +
		`\n\nFile tracciati (git ls-files):\n` +
		tracked.join("\n") +
		`\n\nCome procedere:\n` +
		`1. Per ogni file modificato/aggiunto/rimosso nello status, trova la sua voce nel README: leggi i file cambiati (SKILL.md, agent md, header delle estensioni, models.json, settings.json) e aggiorna descrizioni, comandi e tabelle in base a cosa fanno ORA.\n` +
		`2. File tracciati nuovi non ancora documentati → aggiungi le voci; file rimossi → elimina le voci.\n` +
		`3. Aggiorna i conteggi tipo "(7)" negli header delle sezioni.\n` +
		`4. Scrivi ~/.pi/README.md e rispondi con un riepilogo di 3-6 bullet di cosa hai cambiato. NON committare: lo fa /pi-git --update.`
	);
}

async function runReadme(ctx: any, pi: ExtensionAPI): Promise<void> {
	const ls = await git(["ls-files"]);
	const status = await git(["status", "--porcelain"]);
	ctx.ui.notify("Diff calcolato — delego la rigenerazione del README…", "info");
	pi.sendUserMessage(
		buildReadmeMessage(status.out, ls.ok ? ls.out.split("\n").filter(Boolean) : []),
		{ triggerTurn: true },
	);
}

async function runConfig(ctx: any): Promise<void> {
	let m = loadManifest() ?? { ...DEFAULT_MANIFEST };
	const SAVE = "💾  Salva ed esci";
	const MARK = "✓ ";

	for (;;) {
		const pick = await ctx.ui.select("pi-git — cosa gestisci?  (esc: esci)", [
			...CATEGORIES.map((c) => c.label),
			SAVE,
		]);
		if (!pick || pick === SAVE) break;
		const cat = CATEGORIES.find((c) => c.label === pick)!;
		for (;;) {
			const names = listEntries(cat);
			if (!names.length) {
				ctx.ui.notify(`${cat.label}: nessuna voce trovata`, "warning");
				break;
			}
			const items = names.map((n) => `${m[cat.key].includes(n) ? MARK : "  "}${n}`);
			const sel = await ctx.ui.select(`${cat.label} — invio: attiva/disattiva • esc: indietro`, items);
			if (!sel) break;
			const name = sel.slice(MARK.length);
			m[cat.key] = m[cat.key].includes(name)
				? m[cat.key].filter((x) => x !== name)
				: [...m[cat.key], name];
		}
	}
	saveManifest(m);
	ctx.ui.notify(`Whitelist salvata in ~/.pi/pi-git.json — poi /pi-git --update`, "success");
}

export default function piGit(pi: ExtensionAPI): void {
	pi.registerCommand("pi-git", {
		description: "Sincronizza la config pi su GitHub: --config = whitelist TUI, --update = commit+push, --readme = riallinea il README",
		getArgumentCompletions: (prefix: string) => {
			const words = ["--config", "--update", "--readme"].filter((w) => w.startsWith(prefix.toLowerCase()));
			return words.length ? words.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args: string, ctx) => {
			const flag = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
			if (flag === "--config" || flag === "-c") {
				await runConfig(ctx);
				return;
			}
			if (flag === "--update" || flag === "-u") {
				ctx.ui.notify((await runUpdate()).slice(0, 400), "info");
				return;
			}
			if (flag === "--readme" || flag === "-r") {
				await runReadme(ctx, pi);
				return;
			}
			ctx.ui.notify("/pi-git --config | --update | --readme", "info");
		},
	});
}