import type { BaseInitializeParams, InitializeResultBase } from '~/types';
import { getCustomEndpointConfig } from '~/app/config';
import { initializeCustom } from '~/endpoints/custom/initialize';
import { applyPolzaRequestTransforms } from './transform';

export async function initializePolza(params: BaseInitializeParams): Promise<InitializeResultBase> {
  const options = await initializeCustom(params);
  const endpointConfig = getCustomEndpointConfig({
    endpoint: params.endpoint,
    appConfig: params.req.config,
  });

  return applyPolzaRequestTransforms({
    options,
    endpointConfig,
    modelOptions: params.model_parameters,
  });
}
