export { VeSyncProviderAddon } from './addon.js'
export {
  vesyncConnectionSchema,
  vesyncPurifierSchema,
  vesyncHumidifierSchema,
  vesyncToggleSchema,
  vesyncSensorSchema,
  VeSyncToggleKindSchema,
  VeSyncSensorKindSchema,
  buildConnectionFormSchema,
  settingsToConnection,
  connectionFromBody,
  slugifyEmail,
  VESYNC_SYSTEM,
} from './config.js'
export type {
  VeSyncConnectionConfig,
  VeSyncPurifierConfig,
  VeSyncHumidifierConfig,
  VeSyncToggleConfig,
  VeSyncToggleKind,
  VeSyncSensorConfig,
  VeSyncSensorKind,
} from './config.js'
export type {
  VeSyncClient,
  VeSyncClientFactory,
  VeSyncPurifierSnapshot,
  VeSyncHumidifierSnapshot,
  VeSyncDeviceSnapshot,
  VeSyncRegion,
} from './vesync-client-contract.js'
export {
  buildPurifierCandidates,
  buildHumidifierCandidates,
  humidifierNativeId,
  parseHumidifierNativeId,
  buildVeSyncCandidates,
  purifierNativeId,
  parsePurifierNativeId,
} from './vesync-discovery.js'
export { VeSyncIntegrationManager } from './vesync-integration-manager.js'
export {
  createTsVeSyncClientFactory,
  tsVeSyncClientFactory,
  VeSyncLoginError,
} from './vesync-tsvesync-client.js'
export type { VeSyncLoginFailureKind } from './vesync-tsvesync-client.js'
export { testVeSyncConnection } from './vesync-connection-test.js'
export { VeSyncAccountResolver, vesyncAccounts } from './vesync-account-resolver.js'
export { VeSyncPurifierDevice } from './devices/vesync-purifier-device.js'
export { VeSyncHumidifierDevice } from './devices/vesync-humidifier-device.js'
export { VeSyncToggleDevice } from './devices/vesync-toggle-device.js'
export { VeSyncSensorDevice } from './devices/vesync-sensor-device.js'
