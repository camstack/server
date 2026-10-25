export { HaProviderAddon } from './addon.js'
export type { HaBrokerEntry } from './ha-broker-registry.js'
export {
  authToSettings,
  HaBrokerEntrySchema,
  HaBrokerRegistry,
  settingsToAuth,
} from './ha-broker-registry.js'
export type {
  HaEntityStateMap,
  SubscribeEntitiesOptions,
} from './ha-events.js'

export {
  processEvent,
  subscribeEntities,
} from './ha-events.js'
export { HaExportAddon } from './ha-export/ha-export.addon.js'
export type {
  HaBrokerInfo,
  HaBrokerStatus,
  HaIntegrationManagerOptions,
  HaPublishResult,
  PublishTargetHa,
  SubscribeFilterHa,
} from './ha-integration-manager.js'
export { HaIntegrationManager } from './ha-integration-manager.js'
export type {
  HaAuthConfig,
  HaCompactStateDelta,
  HaCompactStateNew,
  HaCompactUpdate,
  HaEntityState,
} from './ha-types.js'
export {
  HaAuthConfigSchema,
  HaDomain,
  HaEntityStateSchema,
} from './ha-types.js'
export type {
  HaWsClientCallbacks,
  HaWsClientOptions,
} from './ha-ws-client.js'
export {
  buildHaAuth,
  HaWsClient,
} from './ha-ws-client.js'
