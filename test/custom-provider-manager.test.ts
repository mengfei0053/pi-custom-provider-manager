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
	const select = vi.fn<ExtensionCommandContext["ui"]["select"]>();
	const confirm = vi.fn<ExtensionCommandContext["ui"]["confirm"]>();
	const ctx = {
		hasUI: true,
		ui: { notify, input, select, confirm },
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
		ctx,
		input,
		select,
		confirm,
		notify,
		readModelsConfig,
		registerProvider,
		reload: () => customProviderManager(api),
		runProviderCommand,
		unregisterProvider,
	};
}

function mockModelDiscovery(model: Record<string, unknown>) {
	const fetchMock = vi.fn(async (input: string | URL | Request) => {
		return new Response(
			JSON.stringify(
				input.toString() === "https://models.dev/api.json"
					? {}
					: { data: [model] },
			),
			{ status: 200 },
		);
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function expectManualRuntimeModel(
	fixture: ReturnType<typeof setup>,
	expected: Record<string, unknown>,
) {
	expect(fixture.registerProvider).toHaveBeenLastCalledWith(
		"manual",
		expect.objectContaining({
			models: expect.arrayContaining([
				expect.objectContaining({ id: "vendor/model-a", ...expected }),
			]),
		}),
	);
}

function readManualProvider(fixture: ReturnType<typeof setup>) {
	return (
		fixture.readModelsConfig() as {
			providers: {
				manual: {
					modelOverrides?: Record<string, Record<string, unknown>>;
					models: Array<Record<string, unknown>>;
				};
			};
		}
	).providers.manual;
}

const emptyThinkingLevelMap = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: null,
};

const addManualProvider =
	"add manual https://manual.example.com/v1 MANUAL_API_KEY";
const manualModelCommand = "model manual vendor/model-a";

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


	it("keeps manual context overrides effective immediately, after sync, and on reload", async () => {
		const fixture = setup();
		try {
			const remote = { id: "vendor/model-a", context_window: 32000 };
			const fetchMock = mockModelDiscovery(remote);
			await fixture.runProviderCommand(addManualProvider);
			fetchMock.mockClear();
			fixture.registerProvider.mockClear();

			await fixture.runProviderCommand(
				`${manualModelCommand} set contextWindow 123456`,
			);

			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, { contextWindow: 123456 });
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": { contextWindow: 123456 },
			});

			remote.context_window = 64000;
			await fixture.runProviderCommand("sync manual");
			expect(fetchMock).toHaveBeenCalled();
			expectManualRuntimeModel(fixture, { contextWindow: 123456 });
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": { contextWindow: 123456 },
			});

			fetchMock.mockClear();
			fixture.registerProvider.mockClear();
			fixture.reload();
			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, { contextWindow: 123456 });
		} finally {
			fixture.cleanup();
		}
	});

	it.each(["text,image", "text", "image"])(
		"keeps manual input %s effective immediately, after sync, and on reload",
		async (value) => {
			const fixture = setup();
			try {
				const remote = { id: "vendor/model-a", input: ["text"] };
				const fetchMock = mockModelDiscovery(remote);
				await fixture.runProviderCommand(addManualProvider);
				fetchMock.mockClear();
				fixture.registerProvider.mockClear();
				const expected = { input: value.split(",") };

				await fixture.runProviderCommand(`${manualModelCommand} set input ${value}`);
				expect(fetchMock).not.toHaveBeenCalled();
				expectManualRuntimeModel(fixture, expected);
				expect(readManualProvider(fixture).modelOverrides).toEqual({
					"vendor/model-a": expected,
				});

				remote.input = ["image"];
				await fixture.runProviderCommand("sync manual");
				expect(fetchMock).toHaveBeenCalled();
				expectManualRuntimeModel(fixture, expected);
				expect(readManualProvider(fixture).modelOverrides).toEqual({
					"vendor/model-a": expected,
				});

				fetchMock.mockClear();
				fixture.registerProvider.mockClear();
				fixture.reload();
				expect(fetchMock).not.toHaveBeenCalled();
				expectManualRuntimeModel(fixture, expected);
			} finally {
				fixture.cleanup();
			}
		},
	);

	it("resets input to current discovery without removing context or thinking overrides", async () => {
		const fixture = setup();
		try {
			const remote = { id: "vendor/model-a", supportedInputModalities: ["text"] };
			const fetchMock = mockModelDiscovery(remote);
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
			await fixture.runProviderCommand(`${manualModelCommand} set thinking none`);
			await fixture.runProviderCommand(`${manualModelCommand} set input text`);
			remote.supportedInputModalities = ["text", "image"];
			fetchMock.mockClear();

			await fixture.runProviderCommand(`${manualModelCommand} reset input`);
			const remaining = {
				contextWindow: 123456,
				reasoning: false,
				thinkingLevelMap: emptyThinkingLevelMap,
			};
			expect(fetchMock).toHaveBeenCalledWith(
				"https://manual.example.com/v1/models", expect.anything(),
			);
			expectManualRuntimeModel(fixture, { ...remaining, input: ["text", "image"] });
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": remaining,
			});
			fixture.reload();
			expectManualRuntimeModel(fixture, { ...remaining, input: ["text", "image"] });
		} finally {
			fixture.cleanup();
		}
	});

	it("persists complete manual thinking maps without implicitly adding xhigh", async () => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({
				id: "vendor/model-a",
				thinking: { levels: ["low"] },
			});
			await fixture.runProviderCommand(addManualProvider);
			fetchMock.mockClear();
			await fixture.runProviderCommand(
				`${manualModelCommand} set thinking off,minimal,low,medium,high,xhigh=max,max`,
			);
			const explicitMap = {
				off: "off",
				minimal: "minimal",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "max",
				max: "max",
			};
			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, {
				reasoning: true,
				thinkingLevelMap: explicitMap,
			});
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": { reasoning: true, thinkingLevelMap: explicitMap },
			});

			await fixture.runProviderCommand("sync manual");
			expectManualRuntimeModel(fixture, {
				reasoning: true,
				thinkingLevelMap: explicitMap,
			});
			expect(readManualProvider(fixture).modelOverrides?.["vendor/model-a"]).toEqual({
				reasoning: true,
				thinkingLevelMap: explicitMap,
			});

			fetchMock.mockClear();
			await fixture.runProviderCommand(
				`${manualModelCommand} set thinking medium,high,max`,
			);
			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, {
				reasoning: true,
				thinkingLevelMap: {
					...emptyThinkingLevelMap,
					medium: "medium",
					high: "high",
					max: "max",
				},
			});

			await fixture.runProviderCommand(`${manualModelCommand} set thinking none`);
			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, {
				reasoning: false,
				thinkingLevelMap: emptyThinkingLevelMap,
			});
			expect(readManualProvider(fixture).modelOverrides?.["vendor/model-a"]).toEqual({
				reasoning: false,
				thinkingLevelMap: emptyThinkingLevelMap,
			});
			await fixture.runProviderCommand("sync manual");
			expectManualRuntimeModel(fixture, {
				reasoning: false,
				thinkingLevelMap: emptyThinkingLevelMap,
			});
		} finally {
			fixture.cleanup();
		}
	});

	it("does not enable reasoning for an off-only thinking override", async () => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({
				id: "vendor/model-a",
				thinking: { levels: ["high"] },
			});
			await fixture.runProviderCommand(addManualProvider);
			fetchMock.mockClear();
			await fixture.runProviderCommand(`${manualModelCommand} set thinking off`);
			expect(fetchMock).not.toHaveBeenCalled();
			expectManualRuntimeModel(fixture, {
				reasoning: false,
				thinkingLevelMap: { ...emptyThinkingLevelMap, off: "off" },
			});
		} finally {
			fixture.cleanup();
		}
	});

	it.each(["reset all", "reset"])(
		"resets context independently and restores current automatic properties with %s",
		async (resetCommand) => {
			const fixture = setup();
			try {
				const remote = {
					id: "vendor/model-a",
					context_window: 32000,
					thinking: { levels: ["low"] },
					input: ["text"],
				};
				const fetchMock = mockModelDiscovery(remote);
				await fixture.runProviderCommand(addManualProvider);
				await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
				await fixture.runProviderCommand(`${manualModelCommand} set thinking medium,xhigh=max`);
				const thinkingOverride = {
					reasoning: true,
					thinkingLevelMap: {
						...emptyThinkingLevelMap,
						medium: "medium",
						xhigh: "max",
					},
				};

				remote.context_window = 96000;
				remote.thinking.levels = ["high"];
				fetchMock.mockClear();
				await fixture.runProviderCommand(`${manualModelCommand} reset contextWindow`);
				expect(fetchMock).toHaveBeenCalledWith(
					"https://manual.example.com/v1/models",
					expect.anything(),
				);
				expectManualRuntimeModel(fixture, {
					contextWindow: 96000,
					...thinkingOverride,
				});
				expect(readManualProvider(fixture).modelOverrides).toEqual({
					"vendor/model-a": thinkingOverride,
				});

				await fixture.runProviderCommand(`${manualModelCommand} set input image`);
				remote.context_window = 128000;
				fetchMock.mockClear();
				await fixture.runProviderCommand(`${manualModelCommand} ${resetCommand}`);
				expect(fetchMock).toHaveBeenCalled();
				expectManualRuntimeModel(fixture, { contextWindow: 128000, reasoning: true, input: ["text"] });
				const registeredModels = fixture.registerProvider.mock.calls.at(-1)?.[1].models;
				expect(registeredModels?.find((model) => model.id === remote.id)?.thinkingLevelMap)
					.toMatchObject({ high: "high", medium: null, xhigh: null });
				expect(readManualProvider(fixture).modelOverrides).toBeUndefined();
			} finally {
				fixture.cleanup();
			}
		},
	);

	it("resets thinking without removing a context override", async () => {
		const fixture = setup();
		try {
			const remote = { id: "vendor/model-a", thinking: { levels: ["low"] } };
			const fetchMock = mockModelDiscovery(remote);
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
			await fixture.runProviderCommand(`${manualModelCommand} set thinking none`);
			remote.thinking.levels = ["high"];
			fetchMock.mockClear();
			await fixture.runProviderCommand(`${manualModelCommand} reset thinking`);
			expect(fetchMock).toHaveBeenCalled();
			expectManualRuntimeModel(fixture, {
				contextWindow: 123456,
				reasoning: true,
				thinkingLevelMap: expect.objectContaining({ high: "high" }),
			});
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": { contextWindow: 123456 },
			});
		} finally {
			fixture.cleanup();
		}
	});

	it.each(["input", "all"])("leaves persisted overrides and runtime untouched when reset %s discovery fails", async (field) => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
			await fixture.runProviderCommand(`${manualModelCommand} set thinking none`);
			await fixture.runProviderCommand(`${manualModelCommand} set input image`);
			const before = fixture.readModelsConfig();
			fetchMock.mockClear();
			fetchMock.mockImplementation(async () =>
				new Response("Service unavailable", { status: 503 }),
			);
			fixture.notify.mockClear();
			fixture.registerProvider.mockClear();
			await fixture.runProviderCommand(`${manualModelCommand} reset ${field}`);
			expect(fetchMock).toHaveBeenCalled();
			expect(fixture.notify).toHaveBeenCalledWith(
				expect.stringMatching(/503|fetch|unavailable/i),
				"error",
			);
			expect(fixture.readModelsConfig()).toEqual(before);
			expect(fixture.registerProvider).not.toHaveBeenCalled();
			fixture.reload();
			expectManualRuntimeModel(fixture, {
				contextWindow: 123456,
				reasoning: false,
				thinkingLevelMap: emptyThinkingLevelMap,
				input: ["image"],
			});
		} finally {
			fixture.cleanup();
		}
	});

	it.each([
		[`${manualModelCommand} set contextWindow 0`, /contextWindow|positive|integer/i],
		[`${manualModelCommand} set contextWindow -1`, /contextWindow|positive|integer/i],
		[`${manualModelCommand} set contextWindow 1.5`, /contextWindow|integer/i],
		[`${manualModelCommand} set contextWindow NaN`, /contextWindow|integer/i],
		[`${manualModelCommand} set contextWindow 9007199254740992`, /contextWindow|safe|integer/i],
		[`${manualModelCommand} set input pdf`, /input|pdf/i],
		[`${manualModelCommand} set input audio`, /input|audio/i],
		[`${manualModelCommand} set input video`, /input|video/i],
		[`${manualModelCommand} set input empty`, /input|empty/i],
		[`${manualModelCommand} set input`, /input|usage|model/i],
		[`${manualModelCommand} set input ,`, /input|empty/i],
		[`${manualModelCommand} set input text,`, /input|empty/i],
		[`${manualModelCommand} set input ,image`, /input|empty/i],
		[`${manualModelCommand} set input text,,image`, /input|empty/i],
		[`${manualModelCommand} set input text,text`, /input|duplicate|text/i],
		[`${manualModelCommand} set input image,image`, /input|duplicate|image/i],
		[`${manualModelCommand} set input text,pdf`, /input|pdf/i],
		[`${manualModelCommand} set input text extra`, /usage|argument|model/i],
		[`${manualModelCommand} set thinking turbo`, /thinking|turbo/i],
		[`${manualModelCommand} set thinking low,low`, /thinking|duplicate|low/i],
		[`${manualModelCommand} set thinking xhigh=max,xhigh=high`, /thinking|duplicate|xhigh/i],
		[`${manualModelCommand} set thinking high=turbo`, /thinking|turbo/i],
		[`${manualModelCommand} set thinking none,high`, /thinking|none/i],
		[`${manualModelCommand} set contextWindow`, /contextWindow|usage|model/i],
		[`${manualModelCommand} set thinking`, /thinking|usage|model/i],
		[`${manualModelCommand} set contextWindow 123 extra`, /usage|argument|model/i],
		[`${manualModelCommand} set thinking high extra`, /usage|argument|model/i],
		[`${manualModelCommand} set unknown 123`, /unknown|usage|field/i],
		[`${manualModelCommand} reset unknown`, /unknown|usage|field/i],
		[`${manualModelCommand} reset all extra`, /usage|argument|model/i],
		[`${manualModelCommand} show extra`, /usage|argument|model/i],
		[`${manualModelCommand} unknown`, /unknown|usage|model/i],
		["model missing vendor/model-a set contextWindow 123", /provider|missing/i],
		["model manual missing set contextWindow 123", /model|missing/i],
		["model manual model-a set contextWindow 123", /model|model-a/i],
		["model manual VENDOR/model-a set thinking high", /model|VENDOR\/model-a/i],
		["model manual missing reset all", /model|missing/i],
		["model missing vendor/model-a show", /provider|missing/i],
		["model manual missing show", /model|missing/i],
	])("rejects invalid model command without writes: %s", async (command, errorPattern) => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
			await fixture.runProviderCommand(addManualProvider);
			const before = fixture.readModelsConfig();
			fetchMock.mockClear();
			fixture.registerProvider.mockClear();
			fixture.notify.mockClear();
			await fixture.runProviderCommand(command);
			expect(fixture.notify).toHaveBeenCalledWith(
				expect.stringMatching(errorPattern),
				"error",
			);
			expect(fixture.readModelsConfig()).toEqual(before);
			expect(fixture.registerProvider).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			fixture.cleanup();
		}
	});

	it("shows the effective model, override key, and configuration without network requests", async () => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
			await fixture.runProviderCommand(`${manualModelCommand} set thinking medium,xhigh=max`);
			const before = fixture.readModelsConfig();
			fetchMock.mockClear();
			fixture.registerProvider.mockClear();
			fixture.notify.mockClear();
			await fixture.runProviderCommand(`${manualModelCommand} show`);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(fixture.registerProvider).not.toHaveBeenCalled();
			expect(fixture.readModelsConfig()).toEqual(before);
			const output = fixture.notify.mock.calls.map(([message]) => String(message)).join("\n");
			expect(output).toContain("vendor/model-a");
			expect(output).toMatch(/model/i);
			expect(output).toMatch(/override.?key/i);
			expect(output).toContain("contextWindow");
			expect(output).toContain("123456");
			expect(output).toContain("thinkingLevelMap");
			expect(output).toContain("xhigh");
			expect(output).toContain("max");
			expect(fixture.notify.mock.calls.some(([, level]) => level === "error")).toBe(false);
		} finally {
			fixture.cleanup();
		}
	});

	it("edits context through the interactive provider and model picker", async () => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
			await fixture.runProviderCommand(addManualProvider);
			fetchMock.mockClear();
			fixture.select.mockResolvedValueOnce("manual").mockResolvedValueOnce("vendor/model-a").mockResolvedValueOnce("编辑上下文长度");
			fixture.input.mockResolvedValueOnce("123456");
			await fixture.runProviderCommand("model");
			expectManualRuntimeModel(fixture, { contextWindow: 123456 });
			expect(readManualProvider(fixture).modelOverrides).toEqual({ "vendor/model-a": { contextWindow: 123456 } });
			expect(fetchMock).not.toHaveBeenCalled();
			expect(fixture.input).toHaveBeenCalledWith(expect.stringContaining("tokens"), "32000");
		} finally { fixture.cleanup(); }
	});

	it.each([false, true])("edits input interactively and recovers from an empty selection: %s", async (tryEmpty) => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", input: ["text"] });
			await fixture.runProviderCommand(addManualProvider);
			const before = fixture.readModelsConfig();
			fetchMock.mockClear();
			fixture.notify.mockClear();
			fixture.registerProvider.mockClear();
			fixture.select.mockResolvedValueOnce("编辑支持的输入类型");
			if (tryEmpty) {
				fixture.select.mockResolvedValueOnce("[✓] text")
					.mockResolvedValueOnce("保存选择 / Save")
					.mockImplementationOnce(async () => {
						expect(fixture.notify).toHaveBeenCalled();
						expect(fixture.readModelsConfig()).toEqual(before);
						expect(fixture.registerProvider).not.toHaveBeenCalled();
						return "[ ] text";
					});
			}
			fixture.select.mockResolvedValueOnce("[ ] image")
				.mockResolvedValueOnce("保存选择 / Save");
			await fixture.runProviderCommand(manualModelCommand);

			expect(fixture.select).toHaveBeenNthCalledWith(1, expect.any(String),
				expect.arrayContaining(["编辑支持的输入类型", "恢复自动输入类型"]));
			expect(fixture.select).toHaveBeenNthCalledWith(2, expect.any(String),
				["保存选择 / Save", "[✓] text", "[ ] image"]);
			if (tryEmpty) {
				expect(fixture.select).toHaveBeenNthCalledWith(4, expect.any(String),
					["保存选择 / Save", "[ ] text", "[ ] image"]);
			}
			expect(fixture.select).toHaveBeenLastCalledWith(expect.any(String),
				["保存选择 / Save", "[✓] text", "[✓] image"]);
			expectManualRuntimeModel(fixture, { input: ["text", "image"] });
			expect(readManualProvider(fixture).modelOverrides).toEqual({
				"vendor/model-a": { input: ["text", "image"] },
			});
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			fixture.cleanup();
		}
	});

	it("toggles thinking levels interactively with an explicit xhigh mapping", async () => {
		const fixture = setup();
		try {
			mockModelDiscovery({ id: "vendor/model-a", thinking: { levels: ["low"] } });
			await fixture.runProviderCommand(addManualProvider);
			fixture.select.mockResolvedValueOnce("编辑支持的思考强度")
				.mockResolvedValueOnce("[✓] low").mockResolvedValueOnce("[ ] high")
				.mockResolvedValueOnce("[ ] xhigh").mockResolvedValueOnce("max")
				.mockResolvedValueOnce("保存选择 / Save");
			await fixture.runProviderCommand("model manual vendor/model-a");
			expectManualRuntimeModel(fixture, { reasoning: true, thinkingLevelMap: { ...emptyThinkingLevelMap, high: "high", xhigh: "max" } });
		} finally { fixture.cleanup(); }
	});

	it.each(["provider", "model", "operation", "input", "modalities", "thinking", "mapping", "confirm", "input-confirm"])(
		"cancels interactive editing at %s without writes or network requests", async (stage) => {
			const fixture = setup();
			try {
				const fetchMock = mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
				await fixture.runProviderCommand(addManualProvider);
				const before = fixture.readModelsConfig();
				fetchMock.mockClear(); fixture.registerProvider.mockClear(); fixture.notify.mockClear();
				if (stage !== "provider") fixture.select.mockResolvedValueOnce("manual");
				if (!["provider", "model"].includes(stage)) fixture.select.mockResolvedValueOnce("vendor/model-a");
				if (stage === "input") fixture.select.mockResolvedValueOnce("编辑上下文长度");
				if (stage === "modalities") fixture.select.mockResolvedValueOnce("编辑支持的输入类型").mockResolvedValueOnce("[ ] image");
				if (stage === "input-confirm") { fixture.select.mockResolvedValueOnce("恢复自动输入类型"); fixture.confirm.mockResolvedValueOnce(false); }
				if (stage === "thinking" || stage === "mapping") fixture.select.mockResolvedValueOnce("编辑支持的思考强度");
				if (stage === "mapping") fixture.select.mockResolvedValueOnce("[ ] xhigh");
				if (stage === "confirm") { fixture.select.mockResolvedValueOnce("清除全部手动覆盖"); fixture.confirm.mockResolvedValueOnce(false); }
				await fixture.runProviderCommand("model");
				expect(fixture.readModelsConfig()).toEqual(before);
				expect(fetchMock).not.toHaveBeenCalled();
				expect(fixture.registerProvider).not.toHaveBeenCalled();
				expect(fixture.notify).not.toHaveBeenCalled();
			} finally { fixture.cleanup(); }
		},
	);

	it("confirms an interactive reset and restores discovered context", async () => {
		const fixture = setup();
		try {
			mockModelDiscovery({ id: "vendor/model-a", context_window: 32000 });
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set contextWindow 123456`);
			fixture.select.mockResolvedValueOnce("恢复自动上下文长度");
			fixture.confirm.mockResolvedValueOnce(true);
			await fixture.runProviderCommand("model manual vendor/model-a");
			expectManualRuntimeModel(fixture, { contextWindow: 32000 });
			expect(readManualProvider(fixture).modelOverrides).toBeUndefined();
		} finally { fixture.cleanup(); }
	});

	it("confirms an interactive input reset before restoring remote modalities", async () => {
		const fixture = setup();
		try {
			const fetchMock = mockModelDiscovery({ id: "vendor/model-a", input: ["text"] });
			await fixture.runProviderCommand(addManualProvider);
			await fixture.runProviderCommand(`${manualModelCommand} set input image`);
			const before = fixture.readModelsConfig();
			fetchMock.mockClear();
			fixture.select.mockResolvedValueOnce("恢复自动输入类型");
			fixture.confirm.mockImplementationOnce(async () => {
				expect(fetchMock).not.toHaveBeenCalled();
				expect(fixture.readModelsConfig()).toEqual(before);
				return true;
			});
			await fixture.runProviderCommand(manualModelCommand);
			expect(fixture.confirm).toHaveBeenCalledOnce();
			expect(fetchMock).toHaveBeenCalled();
			expectManualRuntimeModel(fixture, { input: ["text"] });
			expect(readManualProvider(fixture).modelOverrides).toBeUndefined();
		} finally {
			fixture.cleanup();
		}
	});

	it("requires explicit arguments without a UI", async () => {
		const fixture = setup();
		try {
			fixture.ctx.hasUI = false;
			await fixture.runProviderCommand("model");
			expect(fixture.notify).toHaveBeenCalledWith(expect.stringContaining("requires a UI"), "error");
			expect(fixture.select).not.toHaveBeenCalled();
		} finally { fixture.cleanup(); }
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
