export { EcowittProviderAddon } from './addon.js'
export {
  ecowittConfigSchema,
  connectionFromSettings,
  gatewayKeyOf,
  ECOWITT_SYSTEM,
  buildConnectionFormSchema,
  settingsToEcowittConfig,
} from './config.js'
export type {
  EcowittConfig,
  EcowittLocalConfig,
  EcowittListenerConfig,
  EcowittConnectionRead,
} from './config.js'
export {
  capForQuantity,
  valueFieldForCap,
  sensorLabel,
  deviceGroupForSensor,
  deviceGroupLabel,
  ECOWITT_DEVICE_GROUPS,
} from './ecowitt-mapping.js'
export type {
  EcowittSensorCap,
  EcowittDeviceGroup,
} from './ecowitt-mapping.js'
export {
  buildEcowittGatewayCandidates,
  gatewayDeviceNativeId,
  groupNativeId,
} from './ecowitt-discovery.js'
export { ADDON_MIGRATIONS } from './migrations/index.js'
