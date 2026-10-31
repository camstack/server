export { UnraidProviderAddon } from './addon.js'
export {
  unraidConnectionSchema,
  connectionFromSettings,
  sameConnection,
  UNRAID_SYSTEM,
  buildConnectionFormSchema,
  settingsToConnection,
} from './config.js'
export type { UnraidConnectionConfig, UnraidConnectionRead } from './config.js'
export type {
  UnraidClientLike,
  UnraidClientFactory,
  UnraidClientFactoryInput,
  UnraidSnapshot,
  UnraidArrayInfo,
  UnraidArrayDiskInfo,
  UnraidContainerInfo,
  UnraidCpuInfo,
  UnraidNotificationsInfo,
  UnraidArrayState,
} from './unraid-client-contract.js'
export {
  buildEntityDescriptors,
  buildEntityIdentities,
  entityIdentity,
  findDescriptor,
  slugifyKey,
  UnraidButtonActionSchema,
  UnraidEntityIdentitySchema,
  UnraidEntityKindSchema,
} from './unraid-mapping.js'
export type {
  UnraidButtonAction,
  UnraidEntityDescriptor,
  UnraidEntityIdentity,
  UnraidEntityKind,
  UnraidNumericValue,
} from './unraid-mapping.js'
export {
  buildUnraidCandidates,
  UNRAID_GATEWAY_ID,
  UNRAID_INSTANCE_ID,
  unraidStableId,
} from './unraid-discovery.js'
export type { BuildUnraidCandidatesInput } from './unraid-discovery.js'
export { buildUnraidAdoptionProvider } from './unraid-adoption-provider.js'
export type { UnraidAdoptionProviderDeps } from './unraid-adoption-provider.js'
export { buildUnraidDeviceAdopter } from './unraid-device-adopter.js'
export { UnraidClientRegistry } from './unraid-client-registry.js'
export { reconcileInstanceEntities } from './unraid-entity-reconcile.js'
export {
  UnraidIntegrationManager,
  defaultUnraidClientFactory,
} from './unraid-integration-manager.js'
export type {
  UnraidIntegrationManagerOptions,
  UnraidInstanceStatus,
} from './unraid-integration-manager.js'
export { UnraidNodeResolver, unraidInstances } from './unraid-node-resolver.js'
export { UnraidGatewayDevice, unraidGatewaySchema } from './devices/unraid-gateway-device.js'
export { UnraidInstanceDevice, unraidInstanceSchema } from './devices/unraid-instance-device.js'
export type { UnraidInstanceConfig } from './devices/unraid-instance-device.js'
export { UnraidEntityDevice, unraidEntitySchema } from './devices/unraid-entity-device.js'
export type { UnraidEntityConfig } from './devices/unraid-entity-device.js'
