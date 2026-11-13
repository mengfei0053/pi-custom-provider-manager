# Pi Custom Provider Manager

Pi extension for managing OpenAI-compatible custom providers from a slash command.

## Features

- `/provider add` / `sync` / `list` / `show` / `set` / `model` / `delete`
- Persistent per-model context, thinking, and input modality overrides that take priority over sync metadata
- Discovers models from `<baseUrl>/models`
- Enriches model metadata from `https://models.dev/api.json`
- Stores provider config in an extension-owned file instead of Pi's native `models.json`
- Dynamically registers providers through `pi.registerProvider()`

## Storage

Provider config:

```text
~/.pi/agent/extensions/custom-provider-manager/providers.json
```

models.dev cache:

```text
~/.pi/agent/extensions/custom-provider-manager/models-dev-cache.json
```

## Usage

Install/load the extension in Pi, then use:

```text
/provider add my-gateway https://example.com/v1 MY_GATEWAY_API_KEY My Gateway
/provider sync my-gateway
/provider list
/provider show my-gateway
/provider set my-gateway baseUrl https://other.example.com/v1
/provider delete my-gateway
```

`apiKey` can be an environment variable name/reference such as:

```text
MY_GATEWAY_API_KEY
$MY_GATEWAY_API_KEY
${MY_GATEWAY_API_KEY}
```

For provider requests, the extension sends `Authorization: Bearer <resolved key>` when `authHeader` is enabled.

## Manual model overrides

### Interactive editor

```text
/provider model
/provider model cpa
/provider model cpa devin/swe-2
```

With no arguments the editor asks for provider, model, then an operation. You can edit context length, toggle supported thinking levels or input modalities one at a time, view effective settings, or restore automatic values. Existing thinking selections are marked `[✓]`; choose **Save** to apply them. Enabling `xhigh` asks whether it maps to provider `xhigh` or `max`. Reset requires confirmation. Escape/cancel at any step leaves configuration unchanged. Interactive mode requires a Pi UI; explicit commands remain available for automation.

### Explicit commands

Use the exact model ID from `/provider show <providerId>`, including prefixes such as `devin/`:

```text
/provider model cpa devin/swe-2 show
/provider model cpa devin/swe-2 set contextWindow 262000
/provider model cpa devin/swe-2 set thinking medium,high,xhigh=max,max
/provider model cpa devin/swe-2 set input text,image
```

- `contextWindow` is a positive safe integer measured in tokens.
- `thinking` lists supported Pi levels separated by commas: `off,minimal,low,medium,high,xhigh,max`. Omitted levels are disabled (`null`).
- A mapping such as `xhigh=max` sends the provider's `max` value for Pi's `xhigh` level. Mappings must use known levels; `off` can only map to itself. List `off` explicitly to permit turning thinking off.
- `/provider model cpa devin/swe-2 set thinking none` disables reasoning entirely.
- `input` is a non-empty unique list of `text` and/or `image`. Select them interactively with **编辑支持的输入类型**, or use `set input text` / `set input text,image`. These are Pi model modalities, not an upload filename-extension allowlist; audio, video, and PDF are not supported model input modalities in this integration.
- `show` displays the effective model and its manual override without fetching the network.

Edits are saved in `provider.modelOverrides`, take effect immediately when the provider is re-registered, and survive `/provider sync` and Pi reload/restart. They change metadata; they cannot make an upstream model support a larger context, unsupported thinking parameter, or image input it cannot actually accept.

Clear one field or all manual fields to return to automatic discovery:

```text
/provider model cpa devin/swe-2 reset contextWindow
/provider model cpa devin/swe-2 reset thinking
/provider model cpa devin/swe-2 reset input
/provider model cpa devin/swe-2 reset all
```

`reset` with no field also means `all`. Reset re-fetches the provider's model catalog before saving; if the request fails, persisted overrides remain unchanged. Resetting `thinking` clears both `reasoning` and `thinkingLevelMap`; other manual fields are preserved. `reset all` removes every field in that model's override, including manually configured fields not exposed by these commands.

Existing normalized-ID overrides are reused when there is no exact-ID override. For example, editing `devin/swe-2` updates an existing `swe-2` override if present; that normalized override can also affect other prefixed IDs with the same suffix. `show` includes `overrideKey` so you can see which entry is being edited. Otherwise a new exact-ID entry is created.

## Metadata enrichment

The extension combines data from the provider `/models` endpoint and `models.dev`, fills known Cognition / Devin metadata gaps, then applies per-provider `modelOverrides`.

Priority:

```text
provider.modelOverrides > /models fields > models.dev metadata > built-in Cognition overrides > defaults
```

Detected fields include:

- Context window: `context_window`, `contextWindow`, `max_context_tokens`, `max_model_len`, `context_length`, `max_input_tokens`, `models.dev.limit.context`
- Output limit: `max_output_tokens`, `max_completion_tokens`, `maxTokens`, `models.dev.limit.output`
- Image input: `input`, `input_modalities`, `supportedInputModalities`, `modalities`, `capabilities`, `supports_images`, `models.dev.modalities.input`
- Reasoning / thinking: `supports_reasoning`, `only_reasoning`, `thinking.levels` (Devin/CPA), `reasoning_supported_efforts`, `models.dev.reasoning`
- Cost: `/models` `input_cost` / `output_cost`, plus `models.dev.cost`

Built-in Cognition / Devin overrides fill sparse model metadata for SWE models and Claude Opus/Sonnet 5.5. Both bare IDs and prefixed IDs such as `devin/swe-2` are recognized. SWE-2 defaults to a 262000-token context window, 64000 output tokens, text/image input, and medium/high/max thinking levels. Pi `xhigh` maps to provider `max`; the explicit `max` level is also supported. Claude 5.5 gets low/medium/high/max thinking levels when its metadata omits usable levels.

Per-provider `modelOverrides` in `providers.json` are applied after sync enrichment and take precedence for explicitly configured fields.

Defaults:

```json
{
  "api": "openai-completions",
  "contextWindow": 128000,
  "maxTokens": 16384,
  "input": ["text"],
  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
}
```

## Development

```bash
pnpm install --ignore-scripts
pnpm test
pnpm run check
```

## Publishing

This package is published to npm as:

```text
@fe-essential/pi-custom-provider-manager
```

Publishing is handled by GitHub Actions when a Git tag is pushed. Before publishing, make sure the repository has an npm publish token configured as a GitHub Actions secret:

```text
NPM_TOKEN
```

To publish a new version:

```bash
pnpm version patch # or minor / major
git push origin main --follow-tags
```

Alternatively, create and push a tag manually:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs `pnpm install --frozen-lockfile`, `pnpm run check`, then publishes with:

```bash
pnpm publish --access public --provenance --no-git-checks
```

## License

MIT

## WorkBuddy / OpenAI-compatible reasoning fields

On sync, these remote `/models` fields are mapped when present:

- `supports_reasoning` / `only_reasoning` → `reasoning`
- `reasoning_supported_efforts` (+ default/effort) → `thinkingLevelMap`
- `can_disable_thinking` → whether `off` is allowed
- `supports_images` → `input: ["text","image"]`
- `context_length` / `max_allowed_size` → `contextWindow`
