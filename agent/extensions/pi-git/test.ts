// Self-check della logica di update: usa uno scratch repo già seedato
// (PI_GIT_REPO) e verifica add / remove / always-tracked / no-op.
// Esegui: bash <(sed di driver) — vedi il commento in cima al file.
import { runUpdate, saveManifest } from "./index.ts";
import { execFileSync } from "node:child_process";

const REPO = process.env.PI_GIT_REPO;
if (!REPO) throw new Error("PI_GIT_REPO mancante");
const git = (args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
const tracked = () => git(["ls-files"]).split("\n").filter(Boolean);

// 1. update con whitelist [pdf-compress]: aggiunge la skill e gli always, pushta
const out1 = await runUpdate();
if (!out1.startsWith("Pushato")) throw new Error(`1: ${out1}`);
const t1 = tracked();
if (!t1.includes("agent/skills/pdf-compress/file.txt")) throw new Error(`pdf-compress non tracciato: ${t1}`);
if (!t1.includes("README.md") || !t1.includes("pi-git.json") || !t1.includes("pyproject.toml") || !t1.includes("uv.lock")) throw new Error(`always mancanti: ${t1}`);
if (t1.includes("agent/skills/tts/file.txt")) throw new Error("tts non doveva essere tracciato");

// 2. whitelist cambiata a [tts]: tts aggiunto, pdf-compress rimosso dal tracking,
//    i file "always" (incluso il tool stesso) devono sopravvivere
saveManifest({ skills: ["tts"], agents: [], prompts: [], extensions: [], files: [] });
const out2 = await runUpdate();
if (!out2.startsWith("Pushato")) throw new Error(`2: ${out2}`);
const t2 = tracked();
if (!t2.includes("agent/skills/tts/file.txt")) throw new Error(`tts non aggiunto: ${t2}`);
if (t2.includes("agent/skills/pdf-compress/file.txt")) throw new Error("pdf-compress doveva essere rimosso");
for (const must of ["README.md", "pi-git.json", "pyproject.toml", "uv.lock", "agent/extensions/pi-git/index.ts"]) {
	if (!t2.includes(must)) throw new Error(`always perso dopo update 2: ${must} → ${t2}`);
}

// 3. nessuna modifica → no-op
const out3 = await runUpdate();
if (!out3.startsWith("Già sincronizzato")) throw new Error(`3: ${out3}`);
if (JSON.stringify(tracked()) !== JSON.stringify(t2)) throw new Error("ls-files cambiato dopo no-op");

console.log("OK: add / remove / always / no-op verificati");