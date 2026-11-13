/**
 * Custom provider manager extension.
 *
 * Adds slash commands for managing OpenAI-compatible custom providers in the
 * extension-owned config file at ~/.pi/agent/extensions/custom-provider-manager/providers.json.
 * The sync command fetches `${baseUrl}/models` and rewrites the provider's
 * model list, then registers the provider immediately.
 *
 * Usage:
 *   pi install npm:@fe-essential/pi-custom-provider-manager
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
	max_allowed_size?: unknown;
	max_output_tokens?: unknown;
	max_completion_tokens?: unknown;
	maxTokens?: unknown;
	input?: unknown;
	input_modalities?: unknown;
	supportedInputModalities?: unknown;
	modalities?: unknown;
	capabilities?: unknown;
	input_cost?: unknown;
	output_cost?: unknown;
	supports_reasoning?: unknown;
	only_reasoning?: unknown;
	can_disable_thinking?: unknown;
	reasoning_supported_efforts?: unknown;
	reasoning_default_effort?: unknown;
	reasoning_effort?: unknown;
	supports_images?: unknown;
	/** Devin/CPA catalog shape: { levels: ["medium","high","max"] } */
	thinking?: unknown;
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

/**
 * Local Cognition / Devin metadata when /models and models.dev omit fields.
 * Numbers come from the CPA-embedded Devin catalog (public /v1/models is sparse).
 * context_length for swe-2 is 262000 (not an unpublished 1M estimate).
 */
const SWE2_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} as NonNullable<ManagedModelConfig["thinkingLevelMap"]>;

/** CPA Devin Claude 5.5: thinking.levels low/medium/high/xhigh/max (xhigh → max like SWE). */
const CLAUDE55_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} as NonNullable<ManagedModelConfig["thinkingLevelMap"]>;

const COGNITION_MODEL_OVERRIDES: Record<
	string,
	Partial<ManagedModelConfig> & { name?: string }
> = {
	"swe-2": {
		name: "SWE-2",
		reasoning: true,
		thinkingLevelMap: SWE2_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		contextWindow: 262000,
		maxTokens: 64000,
	},
	"swe-2-lightning": {
		name: "SWE-2 Lightning",
		reasoning: true,
		thinkingLevelMap: SWE2_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		contextWindow: 262144,
		maxTokens: 64000,
	},
	"swe-1-7": {
		name: "SWE-1.7",
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: null,
			medium: "medium",
			high: null,
			xhigh: null,
		} as NonNullable<ManagedModelConfig["thinkingLevelMap"]>,
	},
	// swe-1-6 / swe-1-6-slow: CPA catalog has no thinking field — no forced reasoning.
	"swe-1-6": { name: "SWE-1.6" },
	"swe-1-6-slow": { name: "SWE-1.6 Slow" },
	// Claude 5.5 via CPA/Devin: public /v1/models omits thinking.levels; models.dev
	// only sets reasoning=true → detectThinkingLevelMap yields {off} only.
	"claude-opus-5-5": {
		name: "Claude Opus 5.5",
		reasoning: true,
		thinkingLevelMap: CLAUDE55_THINKING_LEVEL_MAP,
	},
	"claude-sonnet-5-5": {
		name: "Claude Sonnet 5.5",
		reasoning: true,
		thinkingLevelMap: CLAUDE55_THINKING_LEVEL_MAP,
	},
};
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
		models: (config.models ?? []).map((model) =>
			modelForRuntime(applyProviderModelOverride(model, config.modelOverrides)),
		),
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
		"  /provider model [id] [modelId]  (interactive editor)",
		"  /provider model <id> <modelId> show",
		"  /provider model <id> <modelId> set contextWindow <tokens>",
		"  /provider model <id> <modelId> set thinking <off,low,medium,high,xhigh=max,max|none>",
		"  /provider model <id> <modelId> set input <text,image>",
		"  /provider model <id> <modelId> reset [contextWindow|thinking|input|all]",
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
		.filter((model): model is ManagedModelConfig => model !== undefined)
		.map((model) => applyCognitionOverrides(model))
		.map((model) => applyProviderModelOverride(model, provider.modelOverrides));
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
	const reasoning = detectReasoning(item, modelsDevModel);
	const thinkingLevelMap = detectThinkingLevelMap(item, reasoning);
	return {
		id: item.id,
		name: getModelName(item, modelsDevModel),
		api: provider.api ?? DEFAULT_API,
		reasoning,
		thinkingLevelMap,
		input: detectInputModalities(item, modelsDevModel),
		cost: detectCost(item, modelsDevModel),
		contextWindow: detectContextWindow(item, modelsDevModel),
		maxTokens: detectMaxTokens(item, modelsDevModel),
		compat: provider.compat ?? DEFAULT_COMPAT,
	};
}

const PI_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

function collectRemoteThinkingLevels(item: RemoteModel): string[] {
	const supported = new Set<string>();
	const thinking = item.thinking;
	if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
		const levels = (thinking as { levels?: unknown }).levels;
		if (Array.isArray(levels)) {
			for (const value of levels) {
				if (typeof value === "string" && value.trim()) {
					supported.add(value.trim().toLowerCase());
				}
			}
		}
	}
	if (Array.isArray(item.reasoning_supported_efforts)) {
		for (const value of item.reasoning_supported_efforts) {
			if (typeof value === "string" && value.trim()) {
				supported.add(value.trim().toLowerCase());
			}
		}
	}
	for (const value of [item.reasoning_default_effort, item.reasoning_effort]) {
		if (typeof value === "string" && value.trim()) {
			supported.add(value.trim().toLowerCase());
		}
	}
	return [...supported];
}

function detectReasoning(
	item: RemoteModel,
	modelsDevModel?: ModelsDevModel,
): boolean {
	if (item.supports_reasoning === true || item.only_reasoning === true) {
		return true;
	}
	if (collectRemoteThinkingLevels(item).length > 0) {
		return true;
	}
	if (item.supports_reasoning === false && item.only_reasoning !== true) {
		return false;
	}
	return modelsDevModel?.reasoning ?? false;
}

function detectThinkingLevelMap(
	item: RemoteModel,
	reasoning: boolean,
): ManagedModelConfig["thinkingLevelMap"] | undefined {
	if (!reasoning) {
		return undefined;
	}

	const supported = new Set(collectRemoteThinkingLevels(item));

	// Build as a plain record then cast: peer ModelThinkingLevel shapes vary by pi-ai version.
	const map: Record<string, string | null> = {};
	const canDisable =
		item.can_disable_thinking === true ||
		(item.only_reasoning !== true && !supported.size);

	for (const level of PI_THINKING_LEVELS) {
		if (level === "off") {
			map.off = supported.has("off") || canDisable ? "off" : null;
			continue;
		}
		if (level === "xhigh") {
			// Devin uses "max"; map Pi xhigh → provider "max" when advertised.
			if (supported.has("xhigh")) {
				map.xhigh = "xhigh";
			} else if (supported.has("max")) {
				map.xhigh = "max";
			} else if (supported.size > 0) {
				map.xhigh = null;
			}
			continue;
		}
		if (level === "max") {
			if (supported.has("max")) {
				map.max = "max";
			}
			continue;
		}
		if (supported.has(level)) {
			map[level] = level;
			continue;
		}
		if (supported.size > 0) {
			map[level] = null;
		}
	}

	return Object.keys(map).length > 0
		? (map as NonNullable<ManagedModelConfig["thinkingLevelMap"]>)
		: undefined;
}

/** True when the map has at least one non-off provider level (not just {off}). */
function thinkingMapHasUsableLevels(
	map: ManagedModelConfig["thinkingLevelMap"] | undefined,
): boolean {
	if (!map) {
		return false;
	}
	for (const [level, value] of Object.entries(map)) {
		if (level === "off") {
			continue;
		}
		if (typeof value === "string" && value.length > 0) {
			return true;
		}
	}
	return false;
}

/** Fill gaps left by sparse /models + missing models.dev entries (e.g. Cognition SWE-*). */
function applyCognitionOverrides(model: ManagedModelConfig): ManagedModelConfig {
	const override = COGNITION_MODEL_OVERRIDES[normalizeModelId(model.id)];
	if (!override) {
		return model;
	}
	const next: ManagedModelConfig = { ...model };
	if (override.name && (next.name === next.id || !next.name)) {
		next.name = override.name;
	}
	if (!next.reasoning && override.reasoning) {
		next.reasoning = true;
	}
	// Replace missing or off-only maps (models.dev reasoning without levels).
	if (
		override.thinkingLevelMap &&
		!thinkingMapHasUsableLevels(next.thinkingLevelMap)
	) {
		next.thinkingLevelMap = override.thinkingLevelMap;
	}
	if (
		next.contextWindow === DEFAULT_CONTEXT_WINDOW &&
		override.contextWindow != null
	) {
		next.contextWindow = override.contextWindow;
	}
	if (next.maxTokens === DEFAULT_MAX_TOKENS && override.maxTokens != null) {
		next.maxTokens = override.maxTokens;
	}
	if (
		override.input &&
		(!(next.input ?? []).includes("image") || (next.input ?? []).length === 0)
	) {
		next.input = override.input;
	}
	return next;
}

/** User/provider modelOverrides always win for explicitly set fields. */
function applyProviderModelOverride(
	model: ManagedModelConfig,
	overrides: ManagedProviderConfig["modelOverrides"] | undefined,
): ManagedModelConfig {
	if (!overrides) {
		return model;
	}
	const byId = Object.hasOwn(overrides, model.id) ? overrides[model.id] : undefined;
	const normalizedId = normalizeModelId(model.id);
	const byNormalized = Object.hasOwn(overrides, normalizedId)
		? overrides[normalizedId]
		: undefined;
	const override = byId ?? byNormalized;
	if (!override) {
		return model;
	}
	return {
		...model,
		...override,
		id: model.id,
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
		positiveNumber(item.max_allowed_size) ??
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
	if (item.supports_images === true) {
		return ["text", "image"];
	}
	const modelsDevInputs = modelsDevModel?.modalities?.input ?? [];
	const values = collectStringValues(
		item.input,
		item.input_modalities,
		item.supportedInputModalities,
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

function parseModelOverride(field: string, value: string): Partial<ManagedModelConfig> {
	if (field === "contextWindow") {
		const tokens = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(tokens) || tokens <= 0) {
			throw new Error("contextWindow must be a positive safe integer (tokens).");
		}
		return { contextWindow: tokens };
	}
	if (field === "input") {
		const modalities = value.split(",").map((item) => item.trim());
		if (modalities.some((item) => item !== "text" && item !== "image") || new Set(modalities).size !== modalities.length) {
			throw new Error("input must be a non-empty, unique list of text,image. Pi does not support audio, video, or PDF as model input modalities.");
		}
		return { input: modalities as ("text" | "image")[] };
	}
	if (field !== "thinking") {
		throw new Error(`Unsupported model field: ${field}. Use contextWindow, thinking, or input.`);
	}
	const map: Record<string, string | null> = Object.fromEntries(
		PI_THINKING_LEVELS.map((level) => [level, null]),
	);
	if (value === "none") {
		return { reasoning: false, thinkingLevelMap: map };
	}
	const seen = new Set<string>();
	for (const entry of value.split(",")) {
		const parts = entry.trim().split("=");
		const level = parts[0];
		const target = parts[1] ?? level;
		const validLevel = (candidate: string) =>
			PI_THINKING_LEVELS.some((known) => known === candidate);
		if (parts.length > 2 || !validLevel(level) || !validLevel(target) || seen.has(level)) {
			throw new Error(`Invalid or duplicate thinking level: ${entry}. Use off,minimal,low,medium,high,xhigh,max or xhigh=max.`);
		}
		if ((level === "off") !== (target === "off")) {
			throw new Error("The off thinking level can only map to off.");
		}
		seen.add(level);
		map[level] = target;
	}
	return {
		reasoning: [...seen].some((level) => level !== "off"),
		thinkingLevelMap: map,
	};
}

function resetModelOverride(
	provider: ManagedProviderConfig,
	key: string,
	field: string,
): ManagedProviderConfig {
	if (!["contextWindow", "thinking", "input", "all"].includes(field)) {
		throw new Error("Reset field must be contextWindow, thinking, input, or all.");
	}
	const overrides = { ...provider.modelOverrides };
	const override = { ...overrides[key] };
	if (field === "all") {
		delete overrides[key];
	} else {
		if (field === "contextWindow") delete override.contextWindow;
		else if (field === "input") delete override.input;
		else {
			delete override.reasoning;
			delete override.thinkingLevelMap;
		}
		if (Object.keys(override).length) overrides[key] = override;
		else delete overrides[key];
	}
	const next: ManagedProviderConfig = { ...provider, modelOverrides: overrides };
	if (!Object.keys(overrides).length) delete next.modelOverrides;
	return next;
}

async function promptThinkingOverride(
	ctx: ExtensionCommandContext,
	model: ManagedModelConfig,
): Promise<string | undefined> {
	const selected = new Map<string, string>();
	for (const level of PI_THINKING_LEVELS) {
		const target = model.thinkingLevelMap?.[level as keyof NonNullable<ManagedModelConfig["thinkingLevelMap"]>];
		if (typeof target === "string") selected.set(level, target);
	}
	while (true) {
		const options = [
			"保存选择 / Save",
			"关闭思考能力 / Disable reasoning",
			...PI_THINKING_LEVELS.map((level) =>
				`${selected.has(level) ? "[✓]" : "[ ]"} ${level}${selected.has(level) && selected.get(level) !== level ? ` → ${selected.get(level)}` : ""}`,
			),
		];
		const choice = await ctx.ui.select("选择支持的思考档位（可逐项切换，最后保存）", options);
		if (choice === undefined) return undefined;
		if (choice === options[1]) return "none";
		if (choice === options[0]) {
			if (!selected.size) {
				ctx.ui.notify("请至少选择一个档位，或选择关闭思考能力。", "info");
				continue;
			}
			return [...selected].map(([level, target]) => level === target ? level : `${level}=${target}`).join(",");
		}
		const level = PI_THINKING_LEVELS[options.indexOf(choice) - 2];
		if (!level) continue;
		if (selected.has(level)) selected.delete(level);
		else if (level === "xhigh") {
			const target = await ctx.ui.select("Pi xhigh 对应服务端的哪个值？", ["xhigh", "max"]);
			if (target === undefined) return undefined;
			selected.set(level, target);
		} else selected.set(level, level);
	}
}

async function promptInputOverride(
	ctx: ExtensionCommandContext,
	model: ManagedModelConfig,
): Promise<string | undefined> {
	const modalities = ["text", "image"] as const;
	const selected = new Set<string>(model.input ?? ["text"]);
	while (true) {
		const options = ["保存选择 / Save", ...modalities.map((item) => `${selected.has(item) ? "[✓]" : "[ ]"} ${item}`)];
		const choice = await ctx.ui.select("选择模型支持的输入类型（text 文本 / image 图片）", options);
		if (choice === undefined) return undefined;
		if (choice === options[0]) {
			if (selected.size) return modalities.filter((item) => selected.has(item)).join(",");
			ctx.ui.notify("请至少选择一种输入类型。", "info");
			continue;
		}
		const modality = modalities[options.indexOf(choice) - 1];
		if (!modality) continue;
		if (selected.has(modality)) selected.delete(modality);
		else selected.add(modality);
	}
}

async function collectModelCommandArgs(
	args: string[],
	config: ModelsConfig,
	ctx: ExtensionCommandContext,
): Promise<string[] | undefined> {
	if (args.length >= 3) return args;
	if (!ctx.hasUI) throw new Error("Interactive model editing requires a UI. Use /provider model <id> <modelId> show|set|reset with explicit arguments.");
	const providerIds = Object.keys(config.providers).sort();
	if (!providerIds.length) throw new Error("No custom providers configured.");
	const providerId = args[0] ?? await ctx.ui.select("选择 Provider", providerIds);
	if (providerId === undefined) return undefined;
	const provider = Object.hasOwn(config.providers, providerId) ? config.providers[providerId] : undefined;
	if (!provider) throw new Error(`Provider not found: ${providerId}`);
	const modelIds = (provider.models ?? []).map((model) => model.id);
	if (!modelIds.length) throw new Error(`No models configured for ${providerId}. Run /provider sync ${providerId}.`);
	const modelId = args[1] ?? await ctx.ui.select(`选择模型 · ${providerId}`, modelIds);
	if (modelId === undefined) return undefined;
	const model = provider.models?.find((item) => item.id === modelId);
	if (!model) throw new Error(`Model not found: ${modelId}`);
	const effective = applyProviderModelOverride(model, provider.modelOverrides);
	const operations = ["查看当前配置", "编辑上下文长度", "编辑支持的思考强度", "恢复自动上下文长度", "恢复自动思考强度", "清除全部手动覆盖", "编辑支持的输入类型", "恢复自动输入类型"];
	const operation = await ctx.ui.select(`编辑 ${providerId}/${modelId} · 当前上下文 ${effective.contextWindow ?? DEFAULT_CONTEXT_WINDOW}`, operations);
	if (operation === undefined) return undefined;
	const prefix = [providerId, modelId];
	if (operation === operations[0]) return [...prefix, "show"];
	if (operation === operations[1]) {
		const value = await ctx.ui.input("上下文长度（正整数，单位 tokens）", String(effective.contextWindow ?? DEFAULT_CONTEXT_WINDOW));
		return value === undefined ? undefined : [...prefix, "set", "contextWindow", value.trim()];
	}
	if (operation === operations[2]) {
		const value = await promptThinkingOverride(ctx, effective);
		return value === undefined ? undefined : [...prefix, "set", "thinking", value];
	}
	if (operation === operations[6]) {
		const value = await promptInputOverride(ctx, effective);
		return value === undefined ? undefined : [...prefix, "set", "input", value];
	}
	const resetFields: Record<string, string> = {
		[operations[3]]: "contextWindow",
		[operations[4]]: "thinking",
		[operations[5]]: "all",
		[operations[7]]: "input",
	};
	const field = resetFields[operation];
	if (!field) return undefined;
	const confirmed = await ctx.ui.confirm("恢复自动识别", `将清除 ${providerId}/${modelId} 的 ${field} 覆盖并重新获取模型数据，是否继续？`);
	return confirmed ? [...prefix, "reset", field] : undefined;
}

async function handleModelCommand(
	args: string[],
	config: ModelsConfig,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const collected = await collectModelCommandArgs(args, config, ctx);
	if (!collected) return;
	const [providerId, modelId, action = "show", field, value, ...extra] = collected;
	const provider = Object.hasOwn(config.providers, providerId)
		? config.providers[providerId]
		: undefined;
	if (!provider) throw new Error(`Provider not found: ${providerId ?? "(missing)"}`);
	const model = provider.models?.find((item) => item.id === modelId);
	if (!model) throw new Error(`Model not found: ${modelId ?? "(missing)"}. Use the exact model id from /provider show ${providerId}.`);
	const normalizedId = normalizeModelId(model.id);
	const key = Object.hasOwn(provider.modelOverrides ?? {}, model.id)
		? model.id
		: Object.hasOwn(provider.modelOverrides ?? {}, normalizedId)
			? normalizedId
			: model.id;
	if (action === "show") {
		if (field !== undefined) throw new Error("Usage: /provider model <id> <modelId> show");
		const effective = applyProviderModelOverride(model, provider.modelOverrides);
		// Reuse existing redaction for model-level headers, and never show provider credentials.
		const redacted = redactProvider({ headers: effective.headers });
		ctx.ui.notify(JSON.stringify({
			model: { ...effective, headers: redacted.headers },
			overrideKey: key,
			override: provider.modelOverrides?.[key]
				? { ...provider.modelOverrides[key], headers: redactProvider({ headers: provider.modelOverrides[key].headers }).headers }
				: {},
		}, null, 2), "info");
		return;
	}
	let next: ManagedProviderConfig;
	if (action === "set") {
		if (!field || !value || extra.length) {
			throw new Error("Usage: /provider model <id> <modelId> set <contextWindow|thinking|input> <value>");
		}
		const override = parseModelOverride(field, value);
		next = { ...provider, modelOverrides: {
			...provider.modelOverrides,
			[key]: { ...provider.modelOverrides?.[key], ...override },
		} };
	} else if (action === "reset") {
		if (value !== undefined) throw new Error("Usage: /provider model <id> <modelId> reset [contextWindow|thinking|input|all]");
		next = resetModelOverride(provider, key, field ?? "all");
		// Fetch before writing so a failed reset leaves persisted overrides untouched.
		next.models = await fetchRemoteModels(providerId, next);
	} else {
		throw new Error(`Unknown model action: ${action}. Use show, set, or reset.`);
	}
	config.providers[providerId] = next;
	writeModelsConfig(config);
	registerRuntimeProvider(pi, providerId, next);
	ctx.ui.notify(
		`Updated ${providerId}/${modelId}: ${action} ${field ?? "all"}. Manual overrides take priority and survive sync.`,
		"info",
	);
}

export default function customProviderManager(pi: ExtensionAPI) {
	loadConfiguredProviders(pi);

	pi.registerCommand("provider", {
		description:
			"Manage custom providers in the extension-owned providers.json",
		getArgumentCompletions: (prefix) => {
			const actions = ["list", "show", "add", "sync", "set", "model", "delete"];
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

				if (action === "model") {
					await handleModelCommand(rest, config, pi, ctx);
					return;
				}

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
