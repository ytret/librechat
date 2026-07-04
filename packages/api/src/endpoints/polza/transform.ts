import { Providers } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { InitializeResultBase } from '~/types';
import { extractDefaultParams } from '~/endpoints/openai/llm';

const POLZA_HOST = 'polza.ai';
const POLZA_WEB_PLUGIN = { id: 'web' };
const POLZA_RESPONSES_WEB_TOOL = { type: 'web_search_preview' };

type BooleanParamOptions = {
  key: string;
  modelOptions?: Record<string, unknown>;
  endpointConfig?: Partial<TEndpoint>;
};

function getBooleanParam({ key, modelOptions, endpointConfig }: BooleanParamOptions): boolean {
  let value = modelOptions?.[key];
  const defaultParams = extractDefaultParams(endpointConfig?.customParams?.paramDefinitions);

  if (value === undefined && typeof defaultParams?.[key] === 'boolean') {
    value = defaultParams[key];
  }
  if (typeof endpointConfig?.addParams?.[key] === 'boolean') {
    value = endpointConfig.addParams[key];
  }
  if (endpointConfig?.dropParams?.includes(key)) {
    value = false;
  }

  return value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasPolzaWebPlugin(plugin: unknown): boolean {
  return isRecord(plugin) && plugin.id === POLZA_WEB_PLUGIN.id;
}

function getToolType(tool: unknown): unknown {
  return isRecord(tool) ? tool.type : undefined;
}

function withoutWebSearchTools(tools?: unknown[]): unknown[] {
  return (tools ?? []).filter((tool) => {
    const type = getToolType(tool);
    return type !== 'web_search' && type !== POLZA_RESPONSES_WEB_TOOL.type;
  });
}

function removeWebPlugin(modelKwargs: Record<string, unknown>): void {
  if (!Array.isArray(modelKwargs.plugins)) {
    return;
  }

  const plugins = modelKwargs.plugins.filter((plugin) => !hasPolzaWebPlugin(plugin));
  if (plugins.length > 0) {
    modelKwargs.plugins = plugins;
    return;
  }

  delete modelKwargs.plugins;
}

function cleanupModelKwargs(llmConfig: Record<string, unknown>): void {
  if (!isRecord(llmConfig.modelKwargs) || Object.keys(llmConfig.modelKwargs).length > 0) {
    return;
  }

  delete llmConfig.modelKwargs;
}

export function isPolzaBaseURL(baseURL?: string | null): boolean {
  if (!baseURL) {
    return false;
  }

  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname === POLZA_HOST || hostname.endsWith(`.${POLZA_HOST}`);
  } catch {
    return false;
  }
}

export function isPolzaEndpoint(
  endpointConfig?: Partial<TEndpoint>,
  baseURL?: string | null,
): boolean {
  return endpointConfig?.provider === Providers.POLZA || isPolzaBaseURL(baseURL);
}

export function applyPolzaRequestTransforms({
  options,
  modelOptions,
  endpointConfig,
}: {
  options: InitializeResultBase;
  modelOptions?: Record<string, unknown>;
  endpointConfig?: Partial<TEndpoint>;
}): InitializeResultBase {
  const webSearch = getBooleanParam({ key: 'web_search', modelOptions, endpointConfig });
  if (!webSearch) {
    return options;
  }

  const useResponsesApi = getBooleanParam({
    key: 'useResponsesApi',
    modelOptions,
    endpointConfig,
  });
  const llmConfig = options.llmConfig as Record<string, unknown>;
  const modelKwargs = isRecord(llmConfig.modelKwargs)
    ? llmConfig.modelKwargs
    : ({} as Record<string, unknown>);
  const tools = withoutWebSearchTools(options.tools as unknown[] | undefined);

  if (useResponsesApi) {
    removeWebPlugin(modelKwargs);
    options.tools = [...tools, POLZA_RESPONSES_WEB_TOOL] as InitializeResultBase['tools'];
    llmConfig.modelKwargs = modelKwargs;
    llmConfig.useResponsesApi = true;
    cleanupModelKwargs(llmConfig);
    return options;
  }

  const plugins = Array.isArray(modelKwargs.plugins) ? modelKwargs.plugins : [];
  modelKwargs.plugins = plugins.some(hasPolzaWebPlugin)
    ? plugins
    : [...plugins, POLZA_WEB_PLUGIN];
  llmConfig.modelKwargs = modelKwargs;
  delete llmConfig.useResponsesApi;
  options.tools = tools as InitializeResultBase['tools'];

  return options;
}
