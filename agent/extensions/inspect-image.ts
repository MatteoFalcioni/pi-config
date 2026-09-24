/**
 * inspect_image — let a model WITHOUT vision "see" an image by routing it to
 * a vision-capable model.
 *
 * The model calls:
 *   inspect_image(path, "Is there anything wrong with the login button?")
 *
 * The image is base64-embedded in a one-shot request to the configured vision
 * model (hardcoded default: azure-openai-responses/gpt-5-nano). The reply is
 * returned as text and the nested LLM usage is reported so the cost lands in
 * the session totals.
 *
 * Commands:
 *   /vision-model            pick the vision model (picker over the Ctrl+P
 *                            model list, azure providers only), persisted to
 *                            inspect-image.json
 *   /vision-model reset      back to the hardcoded default
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_VISION_MODEL = { provider: "azure-openai-responses", id: "gpt-5-nano" };

const extensionDir = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(extensionDir, "inspect-image.json");
const MAX_BYTES = 20 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".bmp": "image/bmp",
};

const VISION_SYSTEM_PROMPT =
	"You are a vision assistant. Look at the image and answer the user's question precisely and concisely. " +
	"If the question asks about a problem (bug, layout issue, missing element), state exactly what you observe.";

interface VisionConfig {
	provider: string;
	id: string;
}

async function readConfig(): Promise<VisionConfig | null> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw) as VisionConfig;
		if (typeof parsed?.provider === "string" && typeof parsed?.id === "string") return parsed;
	} catch {
		// Missing or invalid config → use default
	}
	return null;
}

async function writeConfig(config: VisionConfig): Promise<void> {
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function describeModel(model: { provider: string; id: string; name?: string }): string {
	return model.name ? `${model.name} (${model.provider}/${model.id})` : `${model.provider}/${model.id}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "inspect_image",
		label: "Inspect Image",
		description:
			"Look at an image file (e.g. a path returned by browser_screenshot, a rendered PDF page, or any local image) " +
			"by sending it to a separate vision-capable model and returning that model's answer. " +
			"Use this when your current model has no vision but you need to see what an image contains.",
		promptSnippet: "Inspect an image file with a vision model when your current model cannot see images",
		promptGuidelines: [
			"Use inspect_image whenever you need to see an image but your current model has no vision: after browser_screenshot returns a path, when a rendered PDF page needs reading, or when the user references an image file.",
			'Give inspect_image a specific task, e.g. inspect_image(path, "Is there anything wrong with the login button? Describe the page"). Generic "describe this image" requests waste a model call.',
			"inspect_image only observes and reports — the vision model cannot take actions. Act on its findings with your own tools (browser_*, edit, bash).",
		],
		parameters: Type.Object({
			path: Type.String({
				description: "Path to a local image file (png, jpg, webp, gif, bmp). Absolute, or relative to the working directory.",
			}),
			task: Type.String({
				description: "What to look for / answer about the image. Be specific: state what to check or describe.",
			}),
			model: Type.Optional(
				Type.String({
					description: 'Optional vision model override as "provider/model-id" (e.g. "azure-openai-responses/gpt-5-nano"). Normally omitted; the configured vision model is used.',
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { aborted: true } };
			}

			// ── Model resolution: explicit param > config file > hardcoded default ──
			const registry = ctx.modelRegistry;
			let wanted: VisionConfig | null = null;
			if (params.model) {
				const idx = params.model.indexOf("/");
				if (idx <= 0 || idx === params.model.length - 1) {
					throw new Error(`Invalid model "${params.model}" — expected "provider/model-id".`);
				}
				wanted = { provider: params.model.slice(0, idx), id: params.model.slice(idx + 1) };
			} else {
				wanted = (await readConfig()) ?? DEFAULT_VISION_MODEL;
			}
			const model = registry.find(wanted.provider, wanted.id);
			if (!model) {
				throw new Error(
					`Vision model ${wanted.provider}/${wanted.id} not found. Run /vision-model to pick an available one, or add "input": ["text", "image"] to a model in models.json.`,
				);
			}
			if (!registry.hasConfiguredAuth(model)) {
				throw new Error(
					`Vision model ${wanted.provider}/${wanted.id} has no configured auth. Run /vision-model or /login to fix.`,
				);
			}

			// ── Image loading ──
			const imagePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
			const mediaType = MEDIA_TYPES[extname(imagePath).toLowerCase()];
			if (!mediaType) {
				throw new Error(`Unsupported image type "${extname(imagePath)}" — supported: ${Object.keys(MEDIA_TYPES).join(", ")}`);
			}
			const fileStat = await stat(imagePath);
			if (!fileStat.isFile()) throw new Error(`Not a file: ${imagePath}`);
			if (fileStat.size > MAX_BYTES) {
				throw new Error(`Image too large: ${Math.round(fileStat.size / 1024 / 1024)}MB (max ${MAX_BYTES / 1024 / 1024}MB)`);
			}
			const data = (await readFile(imagePath)).toString("base64");

			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { aborted: true } };
			}

			// ── One-shot vision call ──
			onUpdate?.({
				content: [{ type: "text", text: `inspect_image: asking ${describeModel(model)}…` }],
			});

			const stream = registry.streamSimple(model, {
				systemPrompt: VISION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: params.task },
							{ type: "image", data, mimeType: mediaType },
						],
					},
				],
			});

			// Abort: cut the wait short if Esc was pressed (request may finish in the background).
			const result = await new Promise<Awaited<ReturnType<typeof stream.result>>>((resolvePromise, reject) => {
				const done = (fn: () => void) => {
					signal?.removeEventListener("abort", onAbort);
					fn();
				};
				const onAbort = () => done(() => resolvePromise(undefined as never));
				signal?.addEventListener("abort", onAbort, { once: true });
				stream
					.result()
					.then((msg) => done(() => resolvePromise(msg)))
					.catch((err) => done(() => reject(err)));
			});

			if (signal?.aborted || !result) {
				return { content: [{ type: "text", text: "Cancelled" }], details: { aborted: true } };
			}

			const text = result.content.find((c) => c.type === "text")?.text?.trim() ?? "(no text response)";
			return {
				content: [{ type: "text", text }],
				details: {
					model: `${wanted.provider}/${wanted.id}`,
					imagePath: params.path,
				},
				usage: result.usage,
			};
		},

		renderCall(args, theme) {
			const text = new Text("", 0, 0);
			let content = theme.fg("toolTitle", theme.bold("inspect_image ")) + theme.fg("accent", args.path ?? "?");
			if (args.task) {
				const task = (args.task as string).length > 70 ? `${(args.task as string).slice(0, 67)}…` : args.task;
				content += `\n${theme.fg("dim", `  ${task}`)}`;
			}
			text.setText(content);
			return text;
		},

		renderResult(result, _options, theme) {
			const text = new Text("", 0, 0);
			if (result.details?.aborted) {
				text.setText(theme.fg("warning", "inspect_image cancelled"));
				return text;
			}
			if (result.isError) {
				const msg = result.content.find((c) => c.type === "text")?.text ?? "Error";
				text.setText(theme.fg("error", msg));
				return text;
			}
			const answer = result.content.find((c) => c.type === "text")?.text ?? "";
			const preview = answer.length > 200 ? `${answer.slice(0, 197)}…` : answer;
			const model = result.details?.model as string | undefined;
			text.setText(
				[theme.fg("success", "✓ "), theme.fg("accent", model ?? "vision"), theme.fg("dim", " — "), preview].join(""),
			);
			return text;
		},
	});

	pi.registerCommand("vision-model", {
		description: "Pick the vision model used by inspect_image, or pass 'reset' to restore the default (gpt-5-nano)",
		handler: async (args, ctx) => {
			if (args?.trim() === "reset") {
				await unlink(CONFIG_PATH).catch(() => {});
				ctx.ui.notify(`Vision model reset to default ${DEFAULT_VISION_MODEL.provider}/${DEFAULT_VISION_MODEL.id}`, "info");
				return;
			}

			// Pool = the models you can cycle through with Ctrl+P (enabledModels
			// scoping); fall back to the azure vision whitelist if no scoping set.
			const scoped = ctx.scopedModels.map((e) => e.model);
			const candidates = (scoped.length > 0 ? scoped : ctx.modelRegistry.getAvailable())
				// Whitelist: azure providers only — the openrouter catalog stays out of this tool.
				.filter((m) => m.provider.startsWith("azure") && m.input?.includes("image"))
				.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

			if (candidates.length === 0) {
				ctx.ui.notify("No vision-capable available models found. /login to a provider with image models.", "warning");
				return;
			}

			const current = (await readConfig()) ?? DEFAULT_VISION_MODEL;
			const choices = candidates.map(
				(m) => `${m.provider}/${m.id}` === `${current.provider}/${current.id}` ? `${describeModel(m)}  (current)` : describeModel(m),
			);
			const picked = await ctx.ui.select("Vision model for inspect_image:", choices);
			if (!picked) return;

			const idx = choices.indexOf(picked);
			const chosen = candidates[idx];
			if (!chosen) return;

			await writeConfig({ provider: chosen.provider, id: chosen.id });
			ctx.ui.notify(`Vision model set to ${describeModel(chosen)}`, "success");
		},
	});
}