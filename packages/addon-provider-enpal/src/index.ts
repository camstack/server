export { EnpalProviderAddon } from './addon.js'
export {
  buildConnectionFormSchema,
  connectionFromSettings,
  enpalConnectionSchema,
  ENPAL_SYSTEM,
  readConnection,
  sameConnection,
  settingsToConnection,
} from './config.js'
export type { EnpalConnection } from './config.js'
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
export { buildEnpalAdoptionProvider } from './enpal-adoption-provider.js'
export { EnpalClientRegistry } from './enpal-client-registry.js'
export { buildEnpalCandidates } from './enpal-discovery.js'
export {
  ENPAL_EQUIPMENT,
  accessoryChildSpecs,
  enpalEquipmentSchema,
  findEquipment,
} from './enpal-equipment.js'
export type {
  EnpalEquipment,
  EnpalEquipmentConfig,
} from './enpal-equipment.js'
export { EnpalIntegrationManager } from './enpal-integration-manager.js'
export { EnpalConnectionResolver, enpalConnections } from './enpal-resolver.js'
export type { EnpalSnapshot } from './enpal-snapshot.js'
export { EnpalEquipmentDevice } from './devices/enpal-equipment-device.js'
export {
  EnpalSensorDevice,
  enpalSensorSchema,
} from './devices/enpal-sensor-device.js'
