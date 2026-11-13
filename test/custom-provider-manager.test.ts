import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import customProviderManager from "../src/index.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

type CommandHandler = (
	args: string,
	ctx: ExtensionCommandContext,
) => Promise<void> | void;

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
	const input = vi.fn<ExtensionCommandContext["ui"]["input"]>();
	const ctx = {
		hasUI: true,
		ui: { notify, input },
	} as unknown as ExtensionCommandContext;

	async function runProviderCommand(args: string): Promise<void> {
		const command = commands.get("provider");
		if (!command) throw new Error("Missing provider command");
		await command(args, ctx);
	}

	function readModelsConfig(): unknown {
		const raw = readFileSync(
			join(tempDir, "extensions", "custom-provider-manager", "providers.json"),
			"utf8",
		);
		try {
			return JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`Failed to parse test provider config: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	function cleanup() {
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	}

	return {
		cleanup,
		input,
		notify,
		readModelsConfig,
		registerProvider,
		runProviderCommand,
		unregisterProvider,
	};
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
										cost: {
											input: 1.25,
											output: 5,
											cache_read: 0.2,
											cache_write: 1.5,
										},
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
							{
								id: "model-a",
								context_window: 32000,
								input_modalities: ["text"],
							},
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

			await fixture.runProviderCommand(
				"add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY My Gateway",
			);

			expect(fetchMock).toHaveBeenCalledWith("https://example.com/v1/models", {
				headers: {},
			});
			expect(fixture.registerProvider).toHaveBeenCalledWith(
				"my-gateway",
				expect.objectContaining({
					api: "openai-completions",
					apiKey: "MY_GATEWAY_API_KEY",
					baseUrl: "https://example.com/v1",
					models: expect.arrayContaining([
						expect.objectContaining({
							id: "model-a",
							input: ["text"],
							contextWindow: 32000,
						}),
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

	it("prompts for missing add arguments interactively", async () => {
		const fixture = setup();
		try {
			fixture.input
				.mockResolvedValueOnce("interactive-gateway")
				.mockResolvedValueOnce("https://interactive.example.com/v1")
				.mockResolvedValueOnce("INTERACTIVE_API_KEY")
				.mockResolvedValueOnce("Interactive Gateway");
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
						status: 200,
					});
				}),
			);

			await fixture.runProviderCommand("add");

			expect(fixture.input).toHaveBeenNthCalledWith(
				1,
				"Provider id",
				"my-gateway",
			);
			expect(fixture.input).toHaveBeenNthCalledWith(
				2,
				"Base URL",
				"https://example.com/v1",
			);
			expect(fixture.input).toHaveBeenNthCalledWith(
				3,
				"API key env or value",
				"MY_GATEWAY_API_KEY",
			);
			expect(fixture.input).toHaveBeenNthCalledWith(
				4,
				"Display name",
				"interactive-gateway",
			);
			expect(fixture.registerProvider).toHaveBeenCalledWith(
				"interactive-gateway",
				expect.objectContaining({
					name: "Interactive Gateway",
					baseUrl: "https://interactive.example.com/v1",
					apiKey: "INTERACTIVE_API_KEY",
				}),
			);
			expect(fixture.readModelsConfig()).toMatchObject({
				providers: {
					"interactive-gateway": {
						name: "Interactive Gateway",
						baseUrl: "https://interactive.example.com/v1",
					},
				},
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("reports a clear error when /models returns HTML", async () => {
		const fixture = setup();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response("<!doctype html><html>Not Found</html>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				}),
			);

			await fixture.runProviderCommand(
				"add bad https://example.com MY_GATEWAY_API_KEY",
			);

			expect(fixture.notify).toHaveBeenCalledWith(
				expect.stringContaining("not JSON"),
				"error",
			);
			expect(fixture.notify).toHaveBeenCalledWith(
				expect.stringContaining("OpenAI-compatible API root"),
				"error",
			);
		} finally {
			fixture.cleanup();
		}
	});


	it("parses Devin/CPA thinking.levels and supportedInputModalities", async () => {
		const fixture = setup();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(
						JSON.stringify({
							data: [
								{
									id: "other/swe-2",
									display_name: "SWE-2 Remote",
									context_length: 262000,
									max_completion_tokens: 64000,
									supportedInputModalities: ["text", "image"],
									thinking: { levels: ["medium", "high", "max"] },
								},
							],
						}),
						{ status: 200 },
					);
				}),
			);

			await fixture.runProviderCommand(
				"add cpa https://cpa.example.com/v1 CPA_KEY",
			);

			expect(fixture.registerProvider).toHaveBeenCalledWith(
				"cpa",
				expect.objectContaining({
					models: expect.arrayContaining([
						expect.objectContaining({
							id: "other/swe-2",
							name: "SWE-2 Remote",
							reasoning: true,
							contextWindow: 262000,
							maxTokens: 64000,
							input: ["text", "image"],
							thinkingLevelMap: expect.objectContaining({
								medium: "medium",
								high: "high",
								xhigh: "max",
								minimal: null,
								low: null,
							}),
						}),
					]),
				}),
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("applies built-in Cognition overrides for sparse CPA swe-2 ids", async () => {
		const fixture = setup();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(
						JSON.stringify({
							data: [
								{ id: "devin/swe-2", object: "model", owned_by: "cpa" },
								{ id: "devin/swe-2-lightning" },
								{ id: "devin/swe-1-7" },
								{ id: "devin/swe-1-6" },
							],
						}),
						{ status: 200 },
					);
				}),
			);

			await fixture.runProviderCommand(
				"add cpa https://cpa.example.com/v1 CPA_KEY",
			);

			const call = fixture.registerProvider.mock.calls.find(
				(entry) => entry[0] === "cpa",
			);
			expect(call).toBeTruthy();
			const models = (
				(call?.[1] as unknown as { models: Array<Record<string, unknown>> })
			).models;

			const swe2 = models.find((m) => m.id === "devin/swe-2");
			expect(swe2).toMatchObject({
				name: "SWE-2",
				reasoning: true,
				contextWindow: 262000,
				maxTokens: 64000,
				input: ["text", "image"],
			});
			expect(swe2?.thinkingLevelMap).toMatchObject({
				medium: "medium",
				high: "high",
				xhigh: "max",
				max: "max",
				off: null,
			});

			const lightning = models.find((m) => m.id === "devin/swe-2-lightning");
			expect(lightning).toMatchObject({
				reasoning: true,
				contextWindow: 262144,
			});

			const swe17 = models.find((m) => m.id === "devin/swe-1-7");
			expect(swe17).toMatchObject({ reasoning: true });
			expect(swe17?.thinkingLevelMap).toMatchObject({
				medium: "medium",
				high: null,
			});

			const swe16 = models.find((m) => m.id === "devin/swe-1-6");
			expect(swe16).toMatchObject({
				name: "SWE-1.6",
				reasoning: false,
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("applies Claude 5.5 thinking levels when models.dev only sets reasoning", async () => {
		const fixture = setup();
		try {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(
							JSON.stringify({
								anthropic: {
									models: {
										"claude-opus-5-5": {
											id: "claude-opus-5-5",
											name: "Claude Opus 5.5",
											reasoning: true,
											limit: { context: 1000000, output: 128000 },
										},
										"claude-sonnet-5-5": {
											id: "claude-sonnet-5-5",
											name: "Claude Sonnet 5.5",
											reasoning: true,
											limit: { context: 1000000, output: 128000 },
										},
									},
								},
							}),
							{ status: 200 },
						);
					}
					return new Response(
						JSON.stringify({
							data: [
								{ id: "devin/claude-opus-5-5" },
								{ id: "devin/claude-sonnet-5-5" },
								{ id: "claude-opus-5-5" },
							],
						}),
						{ status: 200 },
					);
				}),
			);

			await fixture.runProviderCommand(
				"add cpa https://cpa.example.com/v1 CPA_KEY",
			);

			const call = fixture.registerProvider.mock.calls.find(
				(entry) => entry[0] === "cpa",
			);
			expect(call).toBeTruthy();
			const models = (
				(call?.[1] as unknown as { models: Array<Record<string, unknown>> })
			).models;

			const expectedMap = {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "max",
				max: "max",
				off: null,
			};

			for (const id of [
				"devin/claude-opus-5-5",
				"devin/claude-sonnet-5-5",
				"claude-opus-5-5",
			]) {
				const model = models.find((m) => m.id === id);
				expect(model, id).toBeTruthy();
				expect(model).toMatchObject({
					reasoning: true,
					contextWindow: 1000000,
					maxTokens: 128000,
				});
				expect(model?.thinkingLevelMap).toMatchObject(expectedMap);
			}
		} finally {
			fixture.cleanup();
		}
	});

	it("lets provider modelOverrides win after sync enrichment", async () => {
		const fixture = setup();
		try {
			const tempDir = process.env.PI_CODING_AGENT_DIR!;
			const { mkdirSync, writeFileSync } = await import("node:fs");
			const { join } = await import("node:path");
			const configDir = join(
				tempDir,
				"extensions",
				"custom-provider-manager",
			);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(
				join(configDir, "providers.json"),
				JSON.stringify(
					{
						providers: {
							cpa: {
								baseUrl: "https://cpa.example.com/v1",
								apiKey: "CPA_KEY",
								modelOverrides: {
									"devin/swe-2": {
										contextWindow: 111111,
										name: "SWE-2 override",
									},
								},
							},
						},
					},
					null,
					"\t",
				),
			);

			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request) => {
					if (input.toString() === "https://models.dev/api.json") {
						return new Response(JSON.stringify({}), { status: 200 });
					}
					return new Response(
						JSON.stringify({ data: [{ id: "devin/swe-2" }] }),
						{ status: 200 },
					);
				}),
			);

			await fixture.runProviderCommand("sync cpa");

			expect(fixture.registerProvider).toHaveBeenCalledWith(
				"cpa",
				expect.objectContaining({
					models: expect.arrayContaining([
						expect.objectContaining({
							id: "devin/swe-2",
							name: "SWE-2 override",
							contextWindow: 111111,
							reasoning: true,
							maxTokens: 64000,
						}),
					]),
				}),
			);
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
					return new Response(JSON.stringify({ data: [{ id: "model-a" }] }), {
						status: 200,
					});
				}),
			);

			await fixture.runProviderCommand(
				"add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY",
			);
			await fixture.runProviderCommand(
				"set my-gateway baseUrl https://other.example.com/v1",
			);
			await fixture.runProviderCommand("delete my-gateway");

			expect(fixture.unregisterProvider).toHaveBeenCalledWith("my-gateway");
			expect(fixture.readModelsConfig()).toEqual({ providers: {} });
		} finally {
			fixture.cleanup();
		}
	});
});
