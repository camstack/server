export { PetkitProviderAddon } from './addon.js'
export {
  PETKIT_REGIONS,
  PetkitRegionSchema,
  petkitConfigSchema,
  petkitFeederDeviceSchema,
  buildConnectionFormSchema,
  connectionFromSettings,
  settingsToPetkitConfig,
  sameConnection,
  toNodepetkitOptions,
  toPetkitCredentials,
} from './config.js'
export type { PetkitConfig, PetkitFeederDeviceConfig, PetkitRegionValue } from './config.js'
export { PetkitClientRegistry } from './petkit-client-registry.js'
export { PetkitIntegrationManager, isFeederInfo } from './petkit-integration-manager.js'
export { petkitConnections, PetkitFacadeResolver } from './petkit-gateway.js'
export type { PetkitConnectionSurface } from './petkit-gateway.js'
export { buildPetkitCandidates } from './petkit-discovery.js'
export type { PetkitDiscoverable } from './petkit-discovery.js'
export { buildPetkitAdoptionProvider } from './petkit-adoption-provider.js'
export {
  coldStartFeederStatus,
  decodeFeederError,
  decodeFeederStatus,
  mapFeederToStatus,
  PETKIT_POWER_MODE_BATTERY,
  PETKIT_POWER_MODE_MAINS,
} from './petkit-feeder-mapping.js'
export type { FeederReading, PetFeederDeviceStatus } from './petkit-feeder-mapping.js'
export { PetkitFeederDevice, extractFeederReading } from './devices/petkit-feeder-device.js'
