import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import customProviderManager from "../src/index.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function setup() {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-provider-manager-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tempDir;
	const commands = new Map<string, CommandHandler>();
	const registerProvider = vi.fn<ExtensionAPI["registerProvider"]>();
	const unregisterProvider = vi.fn<ExtensionAPI["unregisterProvider"]>();

	const api = {
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerProvider,
		unregisterProvider,
	} as unknown as ExtensionAPI;

	customProviderManager(api);

	const notify = vi.fn();
	const ctx = {
		ui: { notify },
	} as unknown as ExtensionContext;

	async function runProviderCommand(args: string): Promise<void> {
		const command = commands.get("provider");
		if (!command) throw new Error("Missing provider command");
		await command(args, ctx);
	}

	function readModelsConfig(): unknown {
		return JSON.parse(readFileSync(join(tempDir, "extensions", "custom-provider-manager", "providers.json"), "utf8"));
	}

	function cleanup() {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}

	return { cleanup, notify, readModelsConfig, registerProvider, runProviderCommand, unregisterProvider };
}

describe("custom provider manager example extension", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("adds a provider and discovers models from /models", async () => {
		const fixture = setup();
		try {
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url === "https://models.dev/api.json") {
					return new Response(
						JSON.stringify({
							openai: {
								models: {
									"model-c": {
										id: "model-c",
										name: "Model C from models.dev",
										reasoning: true,
										cost: { input: 1.25, output: 5, cache_read: 0.2, cache_write: 1.5 },
										limit: { context: 256000, output: 32000 },
										modalities: { input: ["text", "image"], output: ["text"] },
									},
								},
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						data: [
							{ id: "model-a", context_window: 32000, input_modalities: ["text"] },
							{
								id: "model-b",
								display_name: "Model B",
								max_context_tokens: 64000,
								max_output_tokens: 8192,
								capabilities: { vision: true },
							},
							{ id: "model-c" },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});
			vi.stubGlobal("fetch", fetchMock);

			await fixture.runProviderCommand("add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY My Gateway");

			expect(fetchMock).toHaveBeenCalledWith("https://example.com/v1/models", { headers: {} });
			expect(fixture.registerProvider).toHaveBeenCalledWith(
				"my-gateway",
				expect.objectContaining({
					api: "openai-completions",
					apiKey: "MY_GATEWAY_API_KEY",
					baseUrl: "https://example.com/v1",
					models: expect.arrayContaining([
						expect.objectContaining({ id: "model-a", input: ["text"], contextWindow: 32000 }),
						expect.objectContaining({
							id: "model-b",
							name: "Model B",
							input: ["text", "image"],
							contextWindow: 64000,
							maxTokens: 8192,
						}),
						expect.objectContaining({
							id: "model-c",
							name: "Model C from models.dev",
							reasoning: true,
							input: ["text", "image"],
							contextWindow: 256000,
							maxTokens: 32000,
							cost: { input: 1.25, output: 5, cacheRead: 0.2, cacheWrite: 1.5 },
						}),
					]),
				} satisfies Partial<ProviderConfig>),
			);
			expect(fixture.readModelsConfig()).toMatchObject({
				providers: {
					"my-gateway": {
						baseUrl: "https://example.com/v1",
						models: expect.arrayContaining([
							expect.objectContaining({ id: "model-a" }),
							expect.objectContaining({ id: "model-b", name: "Model B" }),
							expect.objectContaining({ id: "model-c", contextWindow: 256000 }),
						]),
					},
				},
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("updates and deletes configured providers", async () => {
		const fixture = setup();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), { status: 200 });
				}),
			);

			await fixture.runProviderCommand("add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY");
			await fixture.runProviderCommand("set my-gateway baseUrl https://other.example.com/v1");
			await fixture.runProviderCommand("delete my-gateway");

			expect(fixture.unregisterProvider).toHaveBeenCalledWith("my-gateway");
			expect(fixture.readModelsConfig()).toEqual({ providers: {} });
		} finally {
			fixture.cleanup();
		}
	});
});
