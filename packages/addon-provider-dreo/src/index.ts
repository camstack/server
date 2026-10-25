export { DreoProviderAddon } from './addon.js'
export {
  dreoConfigSchema,
  toDreoConstructorArgs,
  connectionFromSettings,
  buildConnectionFormSchema,
} from './config.js'
export type { DreoConfig, DreoRegionValue } from './config.js'
export {
  classifyDreoModel,
  deviceTypeForKind,
  capsForKind,
  levelToPercentage,
  percentageToLevel,
  percentageStep,
  clampPercent,
  DREO_MAX_FAN_LEVEL,
} from './dreo-domain-mapping.js'
export type { DreoDeviceKind } from './dreo-domain-mapping.js'
export { buildDreoCandidates } from './dreo-discovery.js'
export type { DreoDiscoverable } from './dreo-discovery.js'
