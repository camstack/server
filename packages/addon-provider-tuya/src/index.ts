export { TuyaProviderAddon } from './addon.js'
export {
  tuyaConfigSchema,
  toTuyaCloudOptions,
  settingsToTuyaConfig,
  connectionFromSettings,
  sameConnection,
  buildConnectionFormSchema,
  TUYA_REGION_VALUES,
} from './config.js'
export type { TuyaConfig, TuyaRegionValue } from './config.js'
export {
  classifyTuyaCategory,
  deviceTypeForKind,
  readBooleanDp,
  booleanDpPatch,
  readNumberDp,
  numberDpPatch,
  readStringDp,
  readKettleCurrentTemp,
  readKettleTargetLabel,
  kettleTargetPatch,
  readKettleStatus,
  DEFAULT_SWITCH_DP,
  DEFAULT_KETTLE_DP_MAP,
  DEFAULT_KETTLE_TARGET_OPTIONS,
  KETTLE_CATEGORIES,
} from './tuya-dp-mapping.js'
export type { TuyaDeviceKind, TuyaKettleDpMap } from './tuya-dp-mapping.js'
export { TuyaConnectionResolver, tuyaConnections } from './tuya-gateway.js'
export type { TuyaCatalogEntry, TuyaDeviceHandle } from './tuya-gateway.js'
export {
  TuyaIntegrationManager,
  buildCatalog,
  parseConnection,
} from './tuya-integration-manager.js'
export { TuyaClientRegistry } from './tuya-client-registry.js'
export { buildTuyaCandidates } from './tuya-discovery.js'
export { buildTuyaAdoptionProvider } from './tuya-adoption-provider.js'
