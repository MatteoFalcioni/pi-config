// Self-check of the .gitignore-based pi-git flow (scripted TUI).
// Creates a scratch repo with a local bare remote and verifies: popup track/ignore,
// add -A, README delegation, push with/without README confirmation, no-op, remote-ahead.
// Run:
//   NODE_PATH="$(npm root -g)" PI_GIT_REPO=/tmp/pi-git-test node agent/extensions/pi-git/test.ts

import { runUpdate, runPush, buildReadmeMessage, git } from "./index.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REPO = process.env.PI_GIT_REPO;
if (!REPO) throw new Error("PI_GIT_REPO missing");
const REMOTE = `${REPO}-remote.git`;

const sh = (args: string[], cwd = REPO) => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (p: string, c: string) => fs.writeFileSync(`${REPO}/${p}`, c);
const clean = (p: string) => fs.rmSync(p, { recursive: true, force: true });

// --- setup: seeded repo (README + .gitignore) with local bare remote ---
clean(REPO);
clean(REMOTE);
fs.mkdirSync(`${REPO}/agent/skills/pdf-compress`, { recursive: true });
fs.mkdirSync(`${REPO}/agent/skills/tts`, { recursive: true });
write("README.md", "# pi-config\n\nstub\n");
write(".gitignore", "# machine state\nagent/sessions/\n");
sh(["init", "-b", "main"]);
sh(["config", "user.email", "t@t.io"]);
sh(["config", "user.name", "test"]);
sh(["init", "--bare", "-b", "main", REMOTE]);
sh(["remote", "add", "origin", REMOTE]);
sh(["add", "-A"]);
sh(["commit", "-m", "seed"]);
sh(["push", "-u", "origin", "main"]);

// Scripted TUI: queue of answers for ctx.ui.select (null = Esc)
const scriptedUi = (script: (string | null)[]) => ({
	select: async (_t: string, _o: string[]) => script.length ? script.shift()! : null,
	notify: () => {},
});
let lastDelegated: string | null = null;
const delegate = (m: string) => { lastDelegated = m; };
const earlyGt = (s: string) => { if (!lastDelegated?.includes(s)) throw new Error(`delegated without ${s}: ${lastDelegated}`); };

// 1. update with 2 new skills: the TUI marks tts ✗ (ignore), keeps pdf ✓ → .gitignore
//    written, staging ok, README delegated with the staged list
write("agent/skills/pdf-compress/file.txt", "pdf");
write("agent/skills/tts/file.txt", "tts");
const ui1 = scriptedUi(["✓ agent/skills/tts/", "🚀  Proceed (✗ stay local, out of this push)"]);
const out1 = await runUpdate(ui1, delegate);
if (!out1.includes("--push")) throw new Error(`1: ${out1}`);
if (!fs.readFileSync(`${REPO}/.gitignore`, "utf8").includes("agent/skills/tts/")) throw new Error("1: tts not ignored in .gitignore");
earlyGt("agent/skills/pdf-compress/file.txt");
if (lastDelegated.includes("agent/skills/tts")) throw new Error("1: tts should not be staged");
const st1 = await git(["status", "--porcelain"]);
if (st1.out.includes("tts/file")) throw new Error(`1: tts visible in status: ${st1.out}`);

// 2. push without a modified README → no confirmation, commit+push ok
const out2 = await runPush(scriptedUi([]));
if (!out2.startsWith("Pushed")) throw new Error(`2: ${out2}`);
const t2 = sh(["ls-files"]).split("\n").filter(Boolean);
if (!t2.includes("agent/skills/pdf-compress/file.txt")) throw new Error(`2: pdf not tracked: ${t2}`);
if (t2.includes("agent/skills/tts/file.txt")) throw new Error("2: tts should not be tracked");

// 3. no changes → no-op
const out3 = await runUpdate(scriptedUi([]), () => { throw new Error("3: README delegated without changes"); });
if (!out3.includes("Already in sync")) throw new Error(`3: ${out3}`);
const out3b = await runPush(scriptedUi([]));
if (!out3b.includes("Nothing to push")) throw new Error(`3b: ${out3b}`);

// 4. README regenerated (simulating the model) → confirm YES → pushed
write("README.md", "# pi-config\n\nmodel-updated content\n");
const out4 = await runPush(scriptedUi(["💾  Yes: commit and push with the updated README"]));
if (!out4.startsWith("Pushed")) throw new Error(`4: ${out4}`);
if (!sh(["show", "HEAD:README.md"]).includes("model-updated content")) throw new Error("4: README not in commit");

// 5. README regenerated again → confirm NO → skipped from push, stays in working tree
write("README.md", "# pi-config\n\nunwanted version 2\n");
const out5 = await runPush(scriptedUi(["⏭️   No: skip the README (stays local)"]));
if (!out5.includes("README skipped")) throw new Error(`5: ${out5}`);
if (sh(["show", "HEAD:README.md"]).includes("unwanted version 2")) throw new Error("5: README should not be committed");
if (!fs.readFileSync(`${REPO}/README.md`, "utf8").includes("unwanted version 2")) throw new Error("5: README lost from working tree");

// 6. remote ahead → update aborts before the popup
const clone = `${REPO}-clone`;
clean(clone);
sh(["clone", REMOTE, clone]);
sh(["config", "user.email", "t@t.io"], clone);
sh(["config", "user.name", "test"], clone);
fs.mkdirSync(`${clone}/agent/agents`, { recursive: true });
fs.writeFileSync(`${clone}/agent/agents/worker.md`, "## worker\n");
sh(["add", "-A"], clone);
sh(["commit", "-m", "remote change"], clone);
sh(["push", "origin", "main"], clone);
let popupSeen = false;
const out6 = await runUpdate({ select: async () => { popupSeen = true; return null; }, notify: () => {} }, () => { throw new Error("6: README delegated"); });
if (!out6.includes("git pull")) throw new Error(`6: ${out6}`);
if (popupSeen) throw new Error("6: popup shown despite remote ahead");

// 7. buildReadmeMessage: staged + tracked lists present
const msg = buildReadmeMessage(["README.md", "agent/skills/x/SKILL.md"], ["README.md", "pi-git.json"]);
for (const must of ["README.md", "agent/skills/x/SKILL.md", "pi-git.json", "Part 1"]) {
	if (!msg.includes(must)) throw new Error(`7: missing ${must}`);
}

console.log("OK: popup ignore / stage / README-delegate / push / skip / no-op / drift verified");