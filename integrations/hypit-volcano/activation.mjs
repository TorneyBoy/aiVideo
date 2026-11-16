import { createRuntimeEndpointAdapterFacet, runtimeConfigObject, runtimeConfigExact, runtimeConfigCredentialRef } from '@hypit/runtime-local/extension';
import { createVolcanoProvider } from './provider.mjs';
import { productionFacets, productionManifest } from './production-module.mjs';

export default {
  format: 'hypit.package@1',
  modules: [{ manifest: productionManifest }],
  facets: [...productionFacets, createRuntimeEndpointAdapterFacet({
    use: '@aivideo/hypit-volcano',
    activate(context) {
      const config = runtimeConfigObject(context.config, 'aiVideo Volcengine');
      runtimeConfigExact(config, ['ark', 'apiKey', 'cacheDirectory', 'assetUris', 'seed', 'allowPaidGeneration', 'production'], 'aiVideo Volcengine');
      const apiKey = runtimeConfigCredentialRef(config.apiKey, 'Ark API key');
      if (!apiKey || !context.pool) throw new Error('Ark requires an explicit credential reference and Provider pool');
      return { endpoint: createVolcanoProvider({ ...config, apiKey, instance: context.instance, pool: context.pool }) };
    },
  })],
};
