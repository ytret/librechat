import { Providers } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { InitializeResultBase } from '~/types';
import {
  isPolzaBaseURL,
  isPolzaEndpoint,
  applyPolzaRequestTransforms,
} from './transform';

function createOptions(): InitializeResultBase {
  return {
    llmConfig: {
      streaming: true,
      model: 'gpt-4o',
      useResponsesApi: true,
    },
    tools: [{ type: 'web_search' }],
  } as InitializeResultBase;
}

function createEndpointConfig(endpointConfig?: Partial<TEndpoint>): Partial<TEndpoint> {
  return {
    name: 'Polza',
    baseURL: 'https://polza.ai/api/v1',
    apiKey: 'sk-test',
    models: { default: ['openai/gpt-4o'] },
    ...endpointConfig,
  } as Partial<TEndpoint>;
}

describe('polza transforms', () => {
  it('detects Polza URLs by hostname', () => {
    expect(isPolzaBaseURL('https://polza.ai/api/v1')).toBe(true);
    expect(isPolzaBaseURL('https://gateway.polza.ai/api/v1')).toBe(true);
    expect(isPolzaBaseURL('https://not-polza.ai/api/v1')).toBe(false);
  });

  it('detects explicit Polza providers', () => {
    expect(isPolzaEndpoint(createEndpointConfig({ provider: Providers.POLZA }))).toBe(true);
  });

  it('injects plugins for Chat Completions web search', () => {
    const options = applyPolzaRequestTransforms({
      options: createOptions(),
      endpointConfig: createEndpointConfig(),
      modelOptions: { web_search: true },
    });
    const llmConfig = options.llmConfig as Record<string, unknown>;

    expect(options.tools).toEqual([]);
    expect(llmConfig.useResponsesApi).toBeUndefined();
    expect(llmConfig.modelKwargs).toEqual({
      plugins: [{ id: 'web' }],
    });
  });

  it('injects web_search_preview for Responses API web search', () => {
    const options = applyPolzaRequestTransforms({
      options: createOptions(),
      endpointConfig: createEndpointConfig(),
      modelOptions: {
        web_search: true,
        useResponsesApi: true,
      },
    });
    const llmConfig = options.llmConfig as Record<string, unknown>;

    expect(options.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(llmConfig.useResponsesApi).toBe(true);
    expect(llmConfig.modelKwargs).toBeUndefined();
  });

  it('does not inject Polza fields when web search is disabled', () => {
    const options = applyPolzaRequestTransforms({
      options: createOptions(),
      endpointConfig: createEndpointConfig(),
      modelOptions: { web_search: false },
    });
    const llmConfig = options.llmConfig as Record<string, unknown>;

    expect(options.tools).toEqual([{ type: 'web_search' }]);
    expect(llmConfig.modelKwargs).toBeUndefined();
  });
});
