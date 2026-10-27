export { EnpalProviderAddon } from './addon.js'
export {
  buildConnectionFormSchema,
  enpalBoxSchema,
  enpalConnectionSchema,
  enpalSensorSchema,
  readConnection,
  settingsToConnection,
  slugifyHost,
} from './config.js'
export type { EnpalBoxConfig, EnpalConnection, EnpalSensorConfig } from './config.js'
export {
  ENPAL_SPECS,
  availableSpecs,
  capsOfSpec,
  computeSlices,
  findSpec,
} from './enpal-catalog.js'
export type { EnpalSpec, SpecSlices } from './enpal-catalog.js'
export { LifetimeCounterGuard } from './enpal-counter-guard.js'
export { EnpalError, readEnpalSnapshot } from './enpal-client.js'
export { buildCandidates, parseSpecNativeId, specNativeId } from './enpal-discovery.js'
export { EnpalIntegrationManager } from './enpal-integration-manager.js'
export { EnpalBoxResolver, enpalBoxes } from './enpal-resolver.js'
export type { EnpalSnapshot } from './enpal-snapshot.js'
export { EnpalBoxDevice } from './devices/enpal-box-device.js'
export { EnpalSensorDevice } from './devices/enpal-sensor-device.js'
