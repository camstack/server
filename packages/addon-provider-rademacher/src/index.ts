export { RademacherProviderAddon } from './addon.js'
export {
  rademacherConnectionSchema,
  rademacherHubSchema,
  rademacherCoverSchema,
  buildConnectionFormSchema,
  settingsToConnection,
  slugifyHost,
} from './config.js'
export type {
  RademacherConnectionConfig,
  RademacherHubConfig,
  RademacherCoverConfig,
} from './config.js'
export {
  clampPercent,
  coverStateForPosition,
  toCoverStatus,
  toLibraryPosition,
} from './cover-mapping.js'
export type { RademacherCoverSnapshot, CoverMappingOptions } from './cover-mapping.js'
export { buildCoverCandidates, coverNativeId } from './rademacher-discovery.js'
export type { DiscoverableCover } from './rademacher-discovery.js'
export {
  RademacherIntegrationManager,
  defaultRademacherClientFactory,
} from './rademacher-integration-manager.js'
export { RademacherHubResolver, rademacherHubs } from './rademacher-hub-resolver.js'
export { RademacherHubDevice } from './devices/rademacher-hub-device.js'
export { RademacherCoverDevice } from './devices/rademacher-cover-device.js'
