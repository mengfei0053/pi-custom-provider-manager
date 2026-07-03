# Pi Custom Provider Manager

Pi extension for managing OpenAI-compatible custom providers from a slash command.

## Features

- `/provider add` / `sync` / `list` / `show` / `set` / `delete`
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

## Metadata enrichment

The extension combines data from the provider `/models` endpoint and `models.dev`.

Priority:

```text
/models fields > models.dev metadata > defaults
```

Detected fields include:

- Context window: `context_window`, `contextWindow`, `max_context_tokens`, `max_model_len`, `context_length`, `max_input_tokens`, `models.dev.limit.context`
- Output limit: `max_output_tokens`, `max_completion_tokens`, `maxTokens`, `models.dev.limit.output`
- Image input: `input`, `input_modalities`, `modalities`, `capabilities`, `models.dev.modalities.input`
- Reasoning: `models.dev.reasoning`
- Cost: `/models` `input_cost` / `output_cost`, plus `models.dev.cost`

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
npm install --ignore-scripts
npm test
npm run check
```

## License

MIT
