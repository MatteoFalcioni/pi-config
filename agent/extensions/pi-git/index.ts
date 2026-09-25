/**
 * /pi-git — version the pi configuration to GitHub. Source of truth: .gitignore.
 *
 *   /pi-git --config  TUI: browse skills/agents/prompts/extensions/files and toggle
 *                     tracking (✓ tracked / ✗ ignored) → only touches .gitignore
 *                     (+ git add / rm --cached to keep the index in sync)
 *   /pi-git --update  lists NEW files (track/ignore via TUI), then delegates README
 *                     regeneration to the model based on the staged changes
 *   /pi-git --push    re-stages, asks for confirmation only if README.md changed,
 *                     then commits and pushes
 *
 * Rule: everything NOT in .gitignore gets tracked. "Untrack" = line in .gitignore
 * + git rm --cached (gitignore alone does not untrack files already in git).
 * Core logic is exported and covered by test.ts (scratch repo via PI_GIT_REPO).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileP = promisify(execFile);

const REPO = process.env.PI_GIT_REPO || `${os.homedir()}/.pi`;
const AGENT = `${REPO}/agent`;
const GITIGNORE = `${REPO}/.gitignore`;
const BRANCH = "main";
const REMOTE = "origin";
const USER_MARKER = "# user excludes (managed via /pi-git)";
const MARK_TRACK = "✓ ";
const MARK_IGNORE = "✗ ";

export interface Ui {
	select(title: string, options: string[]): Promise<string | undefined>;
	notify(msg: string, kind?: "info" | "warning" | "error" | "success"): void;
}

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

// --- .gitignore ------------------------------------------------

export function loadGitignore(): string[] {
	try {
		return fs.readFileSync(GITIGNORE, "utf8").split("\n");
	} catch {
		return [];
	}
}

export function saveGitignore(lines: string[]): void {
	fs.writeFileSync(GITIGNORE, lines.join("\n").replace(/\n+$/, "") + "\n");
}

function patternFor(path: string, kind: Category["kind"]): string {
	if (kind === "dirs") return `${path}/`;
	if (kind === "both" && isDir(path)) return `${path}/`;
	return path;
}

function isDir(repoPath: string): boolean {
	try {
		return fs.statSync(`${REPO}/${repoPath}`).isDirectory();
	} catch {
		return false;
	}
}

export function addUserPatterns(patterns: string[]): string[] {
	const cur = loadGitignore();
	const fresh = patterns.filter((p) => p && !cur.includes(p));
	if (!fresh.length) return cur;
	const header = cur.includes(USER_MARKER) ? [] : ["", USER_MARKER];
	const next = [...cur, ...header, ...fresh];
	saveGitignore(next);
	return next;
}

// --- browsable categories (no more manifest) -------------------

interface Category {
	key: string;
	label: string;
	dir: string; // under AGENT
	kind: "dirs" | "files" | "both";
	resolve: (name: string) => string; // repo-relative path
}

const CATEGORIES: Category[] = [
	{ key: "skills", label: "Skills", dir: "skills", kind: "dirs", resolve: (n) => `agent/skills/${n}` },
	{ key: "agents", label: "Agents", dir: "agents", kind: "files", resolve: (n) => `agent/agents/${n}` },
	{ key: "prompts", label: "Prompts", dir: "prompts", kind: "files", resolve: (n) => `agent/prompts/${n}` },
	{ key: "extensions", label: "Extensions", dir: "extensions", kind: "both", resolve: (n) => `agent/extensions/${n}` },
	{ key: "files", label: "Config files", dir: ".", kind: "files", resolve: (n) => `agent/${n}` },
];

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
		.filter((e) => cat.key !== "files" || /\.(json|md)$/.test(e.name))
		.map((e) => e.name)
		.sort();
}

// --- TUI: picking the new files in --update --------------------

export async function chooseIgnores(
	pick: (title: string, options: string[]) => Promise<string | undefined>,
	newFiles: string[],
): Promise<string[]> {
	const DONE = "🚀  Proceed (✗ stay local, out of this push)";
	const ignored = new Set<string>();
	for (;;) {
		const items = [...newFiles.map((f) => `${ignored.has(f) ? MARK_IGNORE : MARK_TRACK}${f}`), DONE];
		const sel = await pick(
			`pi-git — ${newFiles.length} new files: Enter toggles ✓ track / ✗ ignore • Esc: proceed`,
			items,
		);
		if (!sel || sel === DONE) return [...ignored];
		const name = sel.slice(2); // strip "✓ " / "✗ "
		if (ignored.has(name)) ignored.delete(name);
		else ignored.add(name);
	}
}

// --- --update --------------------------------------------------

export async function runUpdate(ui: Ui, delegate: (message: string) => void): Promise<string> {
	await git(["fetch", REMOTE], { timeout: 60_000 }); // best effort: no remote → ignore

	const behind = await git(["rev-list", "--count", `HEAD..${REMOTE}/${BRANCH}`]);
	if (behind.ok && parseInt(behind.out || "0", 10) > 0) {
		return `Remote is ${behind.out} commit(s) ahead: run git pull first.`;
	}

	const st = await git(["status", "--porcelain"]);
	const newFiles = st.ok
		? st.out.split("\n").filter((l) => l.startsWith("??")).map((l) => l.slice(3))
		: [];

	const ignored = newFiles.length ? await chooseIgnores((t, o) => ui.select(t, o), newFiles) : [];
	if (ignored.length) addUserPatterns(ignored);

	const add = await git(["add", "-A"]);
	if (!add.ok) return `git add failed: ${add.err}`;

	const staged = await git(["diff", "--cached", "--name-only"]);
	const stagedList = staged.ok ? staged.out.split("\n").filter(Boolean) : [];
	if (!stagedList.length) {
		return newFiles.length ? "Everything ignored: nothing to push." : "Already in sync: no changes.";
	}

	const ls = await git(["ls-files"]);
	delegate(buildReadmeMessage(stagedList, ls.ok ? ls.out.split("\n").filter(Boolean) : []));
	return `README regenerating (${stagedList.length} files staged). Then run /pi-git --push.`;
}

// --- --push ----------------------------------------------------

const README_YES = "💾  Yes: commit and push with the updated README";
const README_NO = "⏭️   No: skip the README (stays local)";

export async function runPush(ui: Ui): Promise<string> {
	const add = await git(["add", "-A"]);
	if (!add.ok) return `git add failed: ${add.err}`;

	const staged = await git(["diff", "--cached", "--name-only"]);
	let stagedList = staged.ok ? staged.out.split("\n").filter(Boolean) : [];
	if (!stagedList.length) return "Nothing to push: no staged changes.";

	if (stagedList.includes("README.md")) {
		const opt = await ui.select("README.md changed: include it in this push?", [README_YES, README_NO]);
		if (opt === undefined || opt === README_NO) {
			await git(["restore", "--staged", "README.md"]);
			stagedList = stagedList.filter((p) => p !== "README.md");
			if (!stagedList.length) return "README skipped: nothing else to push.";
		}
	}

	const commit = await git(["commit", "-m", `sync pi config (${stagedList.length} files)`]);
	if (!commit.ok) return `Commit failed: ${commit.err}`;

	const push = await git(["push", REMOTE, BRANCH], { timeout: 300_000 });
	if (!push.ok) return `Commit ok, but push failed: ${push.err}`;

	const shown = stagedList.map((p) => p.replace(/^agent\//, "")).slice(0, 4).join(", ");
	const hash = commit.out.match(/\b[0-9a-f]{7,}\b/)?.[0] ?? "?";
	return `Pushed ${hash} (${BRANCH}): ${shown}${stagedList.length > 4 ? ` +${stagedList.length - 4}` : ""}`;
}

// --- delegate README regeneration to the model -----------------

export function buildReadmeMessage(staged: string[], tracked: string[]): string {
	return (
		`[pi-git] Regenerate ~/.pi/README.md to reflect the CURRENT state of the configuration.\n\n` +
		`The repo is ~/.pi and the source of truth is .gitignore: everything NOT ignored is tracked (no more pi-git.json). Strict rules:\n` +
		`- The "Tracked files" list below is the truth: document ONLY those files (and mention .gitignore as the whitelist mechanism). If a path is not in the list (and is not README.md/pyproject.toml/uv.lock/agent/extensions/pi-git), NEVER mention it.\n` +
		`- \`??\` lines in local status are new files NOT yet decided: ignore them.\n` +
		`- "Part 2 — This repository" and "Structure" must describe the /pi-git --config | --update | --push flow with .gitignore as the whitelist (no manifest).\n` +
		`- Everything in English, concise, with tables.\n` +
		`- KEEP UNCHANGED: "Part 1 — Installing pi (from the official repo)", the bold line "The easiest way to install…" under the intro, the Azure credentials disclaimer (⚠️) in the models section, and section "5. Secrets".\n` +
		`- Do not add or remove sections: only update the content of existing ones to reflect the changes.\n` +
		`\nStaged changes (git diff --cached --name-only — about to be pushed):\n` +
		(staged.length ? staged.join("\n") : "(none)") +
		`\n\nTracked files (git ls-files):\n` +
		tracked.join("\n") +
		`\n\nHow to proceed:\n` +
		`1. For every staged file, find its entry in the README: read the changed files (SKILL.md, agent md, extension headers, models.json, settings.json) and update descriptions, commands and tables to reflect what they do NOW.\n` +
		`2. New tracked files not yet documented → add entries; removed files → delete entries.\n` +
		`3. Update the counts like "(7)" in section headers.\n` +
		`4. Write ~/.pi/README.md and reply with a 3-6 bullet summary of what you changed. Do NOT commit and do NOT push: the user runs /pi-git --push, which asks for confirmation if the README changed.`
	);
}

// --- --config: TUI over .gitignore -----------------------------

async function runConfig(ctx: any): Promise<void> {
	const ui: Ui = {
		select: (t, o) => ctx.ui.select(t, o),
		notify: (m, k = "info") => ctx.ui.notify(m, k as any),
	};
	const isIgnored = async (path: string) => (await git(["check-ignore", "-q", "--", path])).ok;

	const SAVE = "💾  Save and exit";
	for (;;) {
		const pick = await ui.select("pi-git — what do you want to manage?  (esc: exit)", [
			...CATEGORIES.map((c) => c.label),
			SAVE,
		]);
		if (!pick || pick === SAVE) break;
		const cat = CATEGORIES.find((c) => c.label === pick)!;
		for (;;) {
			const entries = listEntries(cat);
			if (!entries.length) {
				ui.notify(`${cat.label}: nothing found`, "warning");
				break;
			}
			const items: string[] = [];
			for (const e of entries) {
				const path = cat.resolve(e);
				items.push(`${(await isIgnored(path)) ? MARK_IGNORE : MARK_TRACK}${e}`);
			}
			const sel = await ui.select(
				`${cat.label} — Enter: toggle ✓ tracked / ✗ ignored • Esc: back`,
				items,
			);
			if (!sel) break;
			const name = sel.slice(2);
			const path = cat.resolve(name);
			if (await isIgnored(path)) {
				// track: remove our pattern from .gitignore and re-add
				const pat = patternFor(path, cat.kind);
				saveGitignore(loadGitignore().filter((l) => l !== pat && l !== USER_MARKER));
				await git(["add", "--", path]);
				ui.notify(`${name}: now tracked`, "success");
			} else {
				addUserPatterns([patternFor(path, cat.kind)]);
				await git(["rm", "-r", "--cached", "--quiet", "--", path]);
				ui.notify(`${name}: now ignored (in .gitignore)`, "success");
			}
		}
	}
	ui.notify(".gitignore updated — then /pi-git --update", "success");
}

// --- command ---------------------------------------------------

export default function piGit(pi: ExtensionAPI): void {
	pi.registerCommand("pi-git", {
		description:
			"Sync the pi config with GitHub (whitelist = .gitignore): --config = track/ignore TUI, --update = new files + README, --push = commit+push",
		getArgumentCompletions: (prefix: string) => {
			const words = ["--config", "--update", "--push"].filter((w) => w.startsWith(prefix.toLowerCase()));
			return words.length ? words.map((w) => ({ value: w, label: w })) : null;
		},
		handler: async (args: string, ctx) => {
			const flag = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();
			const ui: Ui = {
				select: (t, o) => ctx.ui.select(t, o),
				notify: (m, k = "info") => ctx.ui.notify(m, k as any),
			};
			if (flag === "--config" || flag === "-c") {
				await runConfig(ctx);
				return;
			}
			if (flag === "--update" || flag === "-u") {
				ui.notify(await runUpdate(ui, (msg) => pi.sendUserMessage(msg, { triggerTurn: true } as any)), "info");
				return;
			}
			if (flag === "--push" || flag === "-p") {
				ui.notify(await runPush(ui), "info");
				return;
			}
			ui.notify("/pi-git --config | --update | --push", "info");
		},
	});
}