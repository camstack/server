export { UnraidProviderAddon } from './addon.js'
export {
  unraidConnectionSchema,
  unraidHubSchema,
  buildConnectionFormSchema,
  settingsToConnection,
  slugifyHost,
} from './config.js'
export type { UnraidConnectionConfig, UnraidHubConfig } from './config.js'
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
export { buildInstanceCandidate, instanceNativeId } from './unraid-discovery.js'
export type { BuildInstanceCandidateInput } from './unraid-discovery.js'
export {
  UnraidIntegrationManager,
  defaultUnraidClientFactory,
} from './unraid-integration-manager.js'
export type {
  UnraidIntegrationManagerOptions,
  UnraidInstanceStatus,
} from './unraid-integration-manager.js'
export { UnraidNodeResolver, unraidInstances } from './unraid-node-resolver.js'
export { UnraidHubDevice } from './devices/unraid-hub-device.js'
export { UnraidInstanceDevice, unraidInstanceSchema } from './devices/unraid-instance-device.js'
export type { UnraidInstanceConfig } from './devices/unraid-instance-device.js'
export { UnraidEntityDevice, unraidEntitySchema } from './devices/unraid-entity-device.js'
export type { UnraidEntityConfig } from './devices/unraid-entity-device.js'
