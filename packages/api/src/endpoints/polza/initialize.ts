import type { BaseInitializeParams, InitializeResultBase } from '~/types';
import { initializeCustom } from '~/endpoints/custom/initialize';

export async function initializePolza(params: BaseInitializeParams): Promise<InitializeResultBase> {
  return initializeCustom(params);
}
