/**
 * Custom provider manager extension.
 *
 * Adds slash commands for managing OpenAI-compatible custom providers in the
 * extension-owned config file at ~/.pi/agent/extensions/custom-provider-manager/providers.json.
 * The sync command fetches `${baseUrl}/models` and rewrites the provider's
 * model list, then registers the provider immediately.
 *
 * Usage:
 *   pi -e ./packages/coding-agent/examples/extensions/custom-provider-manager.ts
 *   /provider add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY
 *   /provider sync my-gateway
 *   /provider list
 *   /provider show my-gateway
 *   /provider set my-gateway apiKey MY_NEW_ENV_VAR
 *   /provider delete my-gateway
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
	type ProviderConfig,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

interface ModelsConfig {
	providers: Record<string, ManagedProviderConfig>;
}

interface ManagedProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: ProviderModelConfig["compat"];
	models?: ManagedModelConfig[];
	modelOverrides?: Record<string, Partial<ManagedModelConfig>>;
}

interface ManagedModelConfig {
	id: string;
	name?: string;
	api?: Api;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ProviderModelConfig["thinkingLevelMap"];
	input?: ("text" | "image")[];
	cost?: ProviderModelConfig["cost"];
	contextWindow?: number;
	maxTokens?: number;
	headers?: Record<string, string>;
	compat?: ProviderModelConfig["compat"];
}

interface ProviderAddInput {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	name?: string;
}

interface ModelsResponse {
	data?: unknown;
}

interface RemoteModel {
	id?: unknown;
	name?: unknown;
	display_name?: unknown;
	context_length?: unknown;
	context_window?: unknown;
	contextWindow?: unknown;
	max_context_tokens?: unknown;
	max_input_tokens?: unknown;
	max_model_len?: unknown;
	max_output_tokens?: unknown;
	max_completion_tokens?: unknown;
	maxTokens?: unknown;
	input?: unknown;
	input_modalities?: unknown;
	modalities?: unknown;
	capabilities?: unknown;
	input_cost?: unknown;
	output_cost?: unknown;
}

interface ModelsDevModel {
	id: string;
	name: string;
	reasoning?: boolean;
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
	};
	limit?: {
		context?: number;
		input?: number;
		output?: number;
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
}

interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

interface ModelsDevCache {
	timestamp: number;
	data: Record<string, ModelsDevProvider>;
}

const DEFAULT_API: Api = "openai-completions";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_COMPAT = {
	supportsDeveloperRole: false,
	maxTokensField: "max_tokens",
} as ProviderModelConfig["compat"];
const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_FILE = "models-dev-cache.json";
const MODELS_DEV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const PROVIDER_MANAGER_DIR = "custom-provider-manager";
const PROVIDER_CONFIG_FILE = "providers.json";

function getProviderConfigPath(): string {
	return join(
		getAgentDir(),
		"extensions",
		PROVIDER_MANAGER_DIR,
		PROVIDER_CONFIG_FILE,
	);
}

function getModelsDevCachePath(): string {
	return join(
		getAgentDir(),
		"extensions",
		PROVIDER_MANAGER_DIR,
		MODELS_DEV_CACHE_FILE,
	);
}

function readModelsConfig(): ModelsConfig {
	const path = getProviderConfigPath();
	if (!existsSync(path)) {
		return { providers: {} };
	}
	const raw = readFileSync(path, "utf8").trim();
	if (!raw) {
		return { providers: {} };
	}
	try {
		const parsed = JSON.parse(raw) as Partial<ModelsConfig>;
		return { providers: parsed.providers ?? {} };
	} catch (error) {
		throw new Error(
			`Failed to parse provider config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function writeModelsConfig(config: ModelsConfig): void {
	const path = getProviderConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "	")}\n`, "utf8");
}

function providerForRuntime(config: ManagedProviderConfig): ProviderConfig {
	return {
		name: config.name,
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		api: config.api,
		headers: config.headers,
		authHeader: config.authHeader,
		models: (config.models ?? []).map(modelForRuntime),
	};
}

function modelForRuntime(model: ManagedModelConfig): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api,
		baseUrl: model.baseUrl,
		reasoning: model.reasoning ?? false,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input ?? ["text"],
		cost: model.cost ?? DEFAULT_COST,
		contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS,
		headers: model.headers,
		compat: model.compat,
	};
}

function registerRuntimeProvider(
	pi: ExtensionAPI,
	providerId: string,
	provider: ManagedProviderConfig,
): void {
	if (!provider.models || provider.models.length === 0) {
		return;
	}
	pi.registerProvider(providerId, providerForRuntime(provider));
}

function loadConfiguredProviders(pi: ExtensionAPI): void {
	const config = readModelsConfig();
	for (const [providerId, provider] of Object.entries(config.providers)) {
		registerRuntimeProvider(pi, providerId, provider);
	}
}

function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				args.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaped) {
		current += "\\";
	}
	if (current) {
		args.push(current);
	}
	return args;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "");
}

function redactProvider(
	provider: ManagedProviderConfig,
): ManagedProviderConfig {
	return {
		...provider,
		apiKey: provider.apiKey ? redactConfigValue(provider.apiKey) : undefined,
		headers: provider.headers
			? Object.fromEntries(
					Object.entries(provider.headers).map(([k, v]) => [
						k,
						redactHeader(k, v),
					]),
				)
			: undefined,
	};
}

function redactConfigValue(value: string): string {
	if (
		/^[A-Z_][A-Z0-9_]*$/.test(value) ||
		value.startsWith("$") ||
		value.startsWith("${") ||
		value.startsWith("!")
	) {
		return value;
	}
	return "<redacted>";
}

function redactHeader(key: string, value: string): string {
	return /authorization|api[-_]?key|token/i.test(key)
		? redactConfigValue(value)
		: value;
}

function usage(): string {
	return [
		"Usage:",
		"  /provider list",
		"  /provider show <id>",
		"  /provider add [id] [baseUrl] [apiKeyEnvOrValue] [displayName]",
		"  /provider sync <id>",
		"  /provider set <id> <baseUrl|apiKey|name|api|authHeader> <value>",
		"  /provider delete <id>",
		"",
		"Run /provider add without arguments for an interactive setup wizard.",
		"Defaults: api=openai-completions, authHeader=true, models from <baseUrl>/models.",
	].join("\n");
}

async function collectProviderAddInput(
	rest: string[],
	ctx: ExtensionCommandContext,
): Promise<ProviderAddInput> {
	const [providerIdArg, baseUrlArg, apiKeyArg, ...nameParts] = rest;
	const needsPrompt = !providerIdArg || !baseUrlArg || !apiKeyArg;
	if (needsPrompt && !ctx.hasUI) {
		throw new Error(
			"Usage: /provider add <id> <baseUrl> <apiKeyEnvOrValue> [displayName]",
		);
	}

	const providerId =
		providerIdArg ?? (await promptRequired(ctx, "Provider id", "my-gateway"));
	const baseUrl =
		baseUrlArg ??
		(await promptRequired(ctx, "Base URL", "https://example.com/v1"));
	const apiKey =
		apiKeyArg ??
		(await promptRequired(ctx, "API key env or value", "MY_GATEWAY_API_KEY"));
	const name =
		nameParts.join(" ") ||
		(ctx.hasUI
			? ((await ctx.ui.input("Display name", providerId))?.trim() ?? "")
			: "");

	return { providerId, baseUrl, apiKey, name: name || undefined };
}

async function promptRequired(
	ctx: ExtensionCommandContext,
	title: string,
	placeholder: string,
): Promise<string> {
	const value = (await ctx.ui.input(title, placeholder))?.trim();
	if (!value) {
		throw new Error(`${title} is required.`);
	}
	return value;
}

function parseBoolean(value: string): boolean {
	if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
	if (["false", "0", "no", "off"].includes(value.toLowerCase())) return false;
	throw new Error(`Invalid boolean: ${value}`);
}

async function fetchRemoteModels(
	providerId: string,
	provider: ManagedProviderConfig,
): Promise<ManagedModelConfig[]> {
	if (!provider.baseUrl) {
		throw new Error(`Provider ${providerId}: baseUrl is required before sync.`);
	}
	const url = `${normalizeBaseUrl(provider.baseUrl)}/models`;
	const headers: Record<string, string> = { ...provider.headers };
	if (provider.authHeader !== false && provider.apiKey) {
		const apiKey = resolveApiKeyForFetch(provider.apiKey);
		if (apiKey) {
			headers.Authorization = `Bearer ${apiKey}`;
		}
	}

	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(
			`GET ${url} failed: ${response.status} ${await response.text()}`,
		);
	}

	const responseText = await response.text();
	let body: ModelsResponse | unknown[];
	try {
		body = JSON.parse(responseText) as ModelsResponse | unknown[];
	} catch (error) {
		const contentType = response.headers.get("content-type") ?? "unknown";
		const preview = responseText.trim().replace(/\s+/g, " ").slice(0, 160);
		throw new Error(
			`GET ${url} returned ${contentType}, not JSON. ` +
				"Check that baseUrl points to an OpenAI-compatible API root " +
				`such as https://example.com/v1. Response starts with: ${preview}`,
		);
	}
	const responseData = (body as ModelsResponse).data;
	const remoteModels: unknown[] = Array.isArray(responseData)
		? responseData
		: Array.isArray(body)
			? body
			: [];
	const modelsDevLookup = await getModelsDevLookup();
	const models = remoteModels
		.map((item) =>
			toManagedModel(item as RemoteModel, provider, modelsDevLookup),
		)
		.filter((model): model is ManagedModelConfig => model !== undefined);
	if (models.length === 0) {
		throw new Error(`GET ${url} returned no usable models.`);
	}
	return models;
}

async function getModelsDevLookup(): Promise<Map<string, ModelsDevModel>> {
	const catalog = await getModelsDevCatalog();
	const lookup = new Map<string, ModelsDevModel>();
	for (const provider of Object.values(catalog)) {
		for (const model of Object.values(provider.models ?? {})) {
			const key = normalizeModelId(model.id);
			if (!lookup.has(key)) lookup.set(key, model);
		}
	}
	return lookup;
}

async function getModelsDevCatalog(): Promise<
	Record<string, ModelsDevProvider>
> {
	const cached = readModelsDevCache();
	if (cached && Date.now() - cached.timestamp <= MODELS_DEV_CACHE_TTL_MS)
		return cached.data;

	try {
		const response = await fetch(MODELS_DEV_URL);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const data = (await response.json()) as Record<string, ModelsDevProvider>;
		writeModelsDevCache(data);
		return data;
	} catch {
		return cached?.data ?? {};
	}
}

function readModelsDevCache(): ModelsDevCache | undefined {
	const path = getModelsDevCachePath();
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as ModelsDevCache;
	} catch {
		return undefined;
	}
}

function writeModelsDevCache(data: Record<string, ModelsDevProvider>): void {
	const path = getModelsDevCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(
		path,
		`${JSON.stringify({ timestamp: Date.now(), data }, null, "\t")}\n`,
		"utf8",
	);
}

function normalizeModelId(id: string): string {
	let normalized = id.toLowerCase();
	if (normalized.startsWith("models/")) normalized = normalized.slice(7);
	const slashIndex = normalized.lastIndexOf("/");
	if (slashIndex !== -1) normalized = normalized.slice(slashIndex + 1);
	return normalized.replaceAll(":", "-");
}

function resolveApiKeyForFetch(configValue: string): string | undefined {
	if (configValue.startsWith("${") && configValue.endsWith("}")) {
		return process.env[configValue.slice(2, -1)];
	}
	if (/^[A-Z_][A-Z0-9_]*$/.test(configValue)) {
		return process.env[configValue];
	}
	if (configValue.startsWith("$")) {
		return process.env[configValue.slice(1)];
	}
	if (configValue.startsWith("!")) {
		return undefined;
	}
	return configValue;
}

function toManagedModel(
	item: RemoteModel,
	provider: ManagedProviderConfig,
	modelsDevLookup: Map<string, ModelsDevModel>,
): ManagedModelConfig | undefined {
	if (typeof item.id !== "string" || item.id.length === 0) {
		return undefined;
	}
	const modelsDevModel = modelsDevLookup.get(normalizeModelId(item.id));
	return {
		id: item.id,
		name: getModelName(item, modelsDevModel),
		api: provider.api ?? DEFAULT_API,
		reasoning: modelsDevModel?.reasoning ?? false,
		input: detectInputModalities(item, modelsDevModel),
		cost: detectCost(item, modelsDevModel),
		contextWindow: detectContextWindow(item, modelsDevModel),
		maxTokens: detectMaxTokens(item, modelsDevModel),
		compat: provider.compat ?? DEFAULT_COMPAT,
	};
}

function getModelName(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): string {
	if (typeof item.name === "string" && item.name.length > 0) return item.name;
	if (typeof item.display_name === "string" && item.display_name.length > 0)
		return item.display_name;
	if (modelsDevModel?.name) return modelsDevModel.name;
	return item.id as string;
}

function detectContextWindow(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): number {
	return (
		positiveNumber(item.context_window) ??
		positiveNumber(item.contextWindow) ??
		positiveNumber(item.max_context_tokens) ??
		positiveNumber(item.max_model_len) ??
		positiveNumber(item.context_length) ??
		positiveNumber(item.max_input_tokens) ??
		positiveNumber(modelsDevModel?.limit?.context) ??
		DEFAULT_CONTEXT_WINDOW
	);
}

function detectMaxTokens(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): number {
	return (
		positiveNumber(item.max_output_tokens) ??
		positiveNumber(item.max_completion_tokens) ??
		positiveNumber(item.maxTokens) ??
		positiveNumber(modelsDevModel?.limit?.output) ??
		DEFAULT_MAX_TOKENS
	);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

function detectCost(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): ProviderModelConfig["cost"] {
	return {
		input:
			positiveNumber(item.input_cost) ??
			positiveNumber(modelsDevModel?.cost?.input) ??
			DEFAULT_COST.input,
		output:
			positiveNumber(item.output_cost) ??
			positiveNumber(modelsDevModel?.cost?.output) ??
			DEFAULT_COST.output,
		cacheRead:
			positiveNumber(modelsDevModel?.cost?.cache_read) ??
			DEFAULT_COST.cacheRead,
		cacheWrite:
			positiveNumber(modelsDevModel?.cost?.cache_write) ??
			DEFAULT_COST.cacheWrite,
	};
}

function detectInputModalities(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): ("text" | "image")[] {
	const modelsDevInputs = modelsDevModel?.modalities?.input ?? [];
	const values = collectStringValues(
		item.input,
		item.input_modalities,
		item.modalities,
		item.capabilities,
		modelsDevInputs,
	);
	const supportsImage = values.some((value) =>
		["image", "vision", "multimodal"].includes(value),
	);
	return supportsImage ? ["text", "image"] : ["text"];
}

function collectStringValues(...values: unknown[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		if (typeof value === "string") {
			result.push(value.toLowerCase());
		} else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") result.push(item.toLowerCase());
			}
		} else if (value && typeof value === "object") {
			for (const [key, item] of Object.entries(value)) {
				if (item === true) result.push(key.toLowerCase());
				if (typeof item === "string") result.push(item.toLowerCase());
			}
		}
	}
	return result;
}

export default function customProviderManager(pi: ExtensionAPI) {
	loadConfiguredProviders(pi);

	pi.registerCommand("provider", {
		description:
			"Manage custom providers in the extension-owned providers.json",
		getArgumentCompletions: (prefix) => {
			const actions = ["list", "show", "add", "sync", "set", "delete"];
			const matches = actions.filter((action) => action.startsWith(prefix));
			return matches.length > 0
				? matches.map((action) => ({ value: action, label: action }))
				: null;
		},
		handler: async (args, ctx) => {
			try {
				const [action, ...rest] = splitArgs(args);
				if (!action || action === "help") {
					ctx.ui.notify(usage(), "info");
					return;
				}

				const config = readModelsConfig();

				if (action === "list") {
					const ids = Object.keys(config.providers).sort();
					ctx.ui.notify(
						ids.length > 0 ? ids.join("\n") : "No custom providers configured.",
						"info",
					);
					return;
				}

				const providerId = rest[0];

				if (action === "add") {
					const input = await collectProviderAddInput(rest, ctx);
					config.providers[input.providerId] = {
						name: input.name ?? input.providerId,
						baseUrl: normalizeBaseUrl(input.baseUrl),
						apiKey: input.apiKey,
						api: DEFAULT_API,
						authHeader: true,
						compat: DEFAULT_COMPAT,
						models: [],
					};
					config.providers[input.providerId].models = await fetchRemoteModels(
						input.providerId,
						config.providers[input.providerId],
					);
					writeModelsConfig(config);
					registerRuntimeProvider(
						pi,
						input.providerId,
						config.providers[input.providerId],
					);
					ctx.ui.notify(
						`Added ${input.providerId} with ${config.providers[input.providerId].models?.length ?? 0} models.`,
						"info",
					);
					return;
				}

				if (!providerId) {
					throw new Error(`Missing provider id.\n${usage()}`);
				}

				if (action === "show") {
					const provider = config.providers[providerId];
					if (!provider) throw new Error(`Provider not found: ${providerId}`);
					ctx.ui.notify(
						`${JSON.stringify(redactProvider(provider), null, 2)}\n\nFile: ${getProviderConfigPath()}`,
						"info",
					);
					return;
				}

				if (action === "sync") {
					const provider = config.providers[providerId];
					if (!provider) throw new Error(`Provider not found: ${providerId}`);
					provider.models = await fetchRemoteModels(providerId, provider);
					writeModelsConfig(config);
					registerRuntimeProvider(pi, providerId, provider);
					ctx.ui.notify(
						`Synced ${provider.models.length} models for ${providerId}.`,
						"info",
					);
					return;
				}

				if (action === "set") {
					const provider = config.providers[providerId];
					if (!provider) throw new Error(`Provider not found: ${providerId}`);
					const [, field, ...valueParts] = rest;
					const value = valueParts.join(" ");
					if (!field || !value) {
						throw new Error(
							"Usage: /provider set <id> <baseUrl|apiKey|name|api|authHeader> <value>",
						);
					}
					if (field === "baseUrl") provider.baseUrl = normalizeBaseUrl(value);
					else if (field === "apiKey") provider.apiKey = value;
					else if (field === "name") provider.name = value;
					else if (field === "api") provider.api = value as Api;
					else if (field === "authHeader")
						provider.authHeader = parseBoolean(value);
					else throw new Error(`Unsupported field: ${field}`);
					writeModelsConfig(config);
					registerRuntimeProvider(pi, providerId, provider);
					ctx.ui.notify(
						`Updated ${providerId}.${field}. Run /provider sync ${providerId} to refresh models if needed.`,
						"info",
					);
					return;
				}

				if (action === "delete" || action === "remove") {
					if (!config.providers[providerId])
						throw new Error(`Provider not found: ${providerId}`);
					delete config.providers[providerId];
					writeModelsConfig(config);
					pi.unregisterProvider(providerId);
					ctx.ui.notify(`Deleted ${providerId}.`, "info");
					return;
				}

				throw new Error(`Unknown action: ${action}\n${usage()}`);
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}
