export { RademacherProviderAddon } from './addon.js'
export {
  rademacherConnectionSchema,
  rademacherGatewayDeviceSchema,
  rademacherCoverSchema,
  buildConnectionFormSchema,
  connectionFromSettings,
  sameRademacherConnection,
} from './config.js'
export type {
  RademacherConnectionConfig,
  RademacherGatewayDeviceConfig,
  RademacherCoverConfig,
} from './config.js'
export {
  clampPercent,
  coverStateForPosition,
  toCoverStatus,
  toLibraryPosition,
} from './cover-mapping.js'
export type { RademacherCoverSnapshot, CoverMappingOptions } from './cover-mapping.js'
export {
  buildRademacherCandidates,
  coverNativeId,
  gatewayNativeId,
  resolveNativeId,
} from './rademacher-discovery.js'
export type { AdoptableCover, ResolvedNativeId } from './rademacher-discovery.js'
export {
  RademacherIntegrationManager,
  defaultRademacherClientFactory,
} from './rademacher-integration-manager.js'
export { RademacherClientRegistry } from './rademacher-client-registry.js'
export { RademacherSessionResolver, rademacherSessions } from './rademacher-session-resolver.js'
export { RademacherGatewayDevice } from './devices/rademacher-gateway-device.js'
export { RademacherCoverDevice } from './devices/rademacher-cover-device.js'
