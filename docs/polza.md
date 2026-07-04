# Polza.ai Provider

LibreChat supports Polza.ai as a dedicated OpenAI-compatible provider.

## Modified files

- `packages/api/src/endpoints/polza/*`: contains the Polza initializer and all Polza request transformations.
- `packages/api/src/endpoints/custom/initialize.ts`: auto-detects custom endpoints whose resolved base URL belongs to Polza and applies the Polza transform.
- `packages/api/src/endpoints/config/providers.ts`: routes explicit `provider: polza` custom endpoints through the Polza initializer.
- `packages/api/src/endpoints/custom/config.ts`: keeps Polza on OpenAI-compatible parameter defaults in the UI.
- `packages/data-provider/src/schemas.ts` and `packages/data-provider/src/config.ts`: register `polza` as an OpenAI-like provider and allow `provider: polza` in custom endpoint config.

## How it works

Polza reuses the existing OpenAI-compatible request construction. After the normal OpenAI config is built, `applyPolzaRequestTransforms` adjusts only Polza requests.

When `web_search` is enabled and the request uses Chat Completions, Polza receives:

```json
{ "plugins": [{ "id": "web" }] }
```

When `web_search` is enabled and `useResponsesApi` is enabled, Polza receives the Responses API web-search tool:

```json
{ "tools": [{ "type": "web_search_preview" }] }
```

No Polza fields are injected when `web_search` is disabled.

## Enable Polza

Configure Polza as a custom endpoint:

```yaml
endpoints:
  custom:
    - name: Polza
      apiKey: "${POLZA_API_KEY}"
      baseURL: "https://polza.ai/api/v1"
      provider: polza
      models:
        default:
          - openai/gpt-4o
```

The `provider: polza` field is explicit. A custom endpoint with a resolved `*.polza.ai` base URL is also auto-detected.

## Future options

Add future Polza-specific request behavior in `packages/api/src/endpoints/polza/transform.ts`, including options such as `reasoning_effort`, annotations, citations, `search_context_size`, `max_results`, and `enable_image_results`.
