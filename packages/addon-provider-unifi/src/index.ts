export { UnifiProviderAddon } from './addon.js'
export {
  unifiConnectionSchema,
  unifiInfraSchema,
  unifiFeatureSchema,
  unifiFeatureDescriptorSchema,
  UnifiFeatureKindSchema,
  UnifiSwitchFeatureSchema,
  UnifiButtonActionSchema,
  UnifiSensorMetricSchema,
  buildConnectionFormSchema,
  connectionFromSettings,
  sameConnection,
  settingsToConnection,
  UNIFI_SYSTEM,
} from './config.js'
export type {
  UnifiConnectionConfig,
  UnifiConnectionRead,
  UnifiInfraConfig,
  UnifiFeatureConfig,
  UnifiFeatureDescriptor,
  UnifiFeatureKind,
  UnifiSwitchFeature,
  UnifiButtonAction,
  UnifiSensorMetric,
} from './config.js'
export type {
  UnifiControllerClient,
  UnifiControllerClientFactory,
  UnifiInfraSnapshot,
  UnifiInfraPort,
  UnifiInfraState,
  UnifiClientSnapshot,
} from './unifi-client-contract.js'
export {
  buildDiscoveryCandidates,
  infraNativeId,
  clientNativeId,
  parseNativeId,
  unifiStableId,
  UNIFI_GATEWAY_ID,
} from './unifi-discovery.js'
export type { ParsedNativeId } from './unifi-discovery.js'
export { buildInfraFeatures, featuresEqual, capForMetric } from './unifi-mapping.js'
export {
  UnifiIntegrationManager,
  defaultUnifiClientFactory,
} from './unifi-integration-manager.js'
export { UnifiControllerResolver, unifiControllers } from './unifi-node-resolver.js'
export { UnifiGatewayDevice, unifiGatewaySchema } from './devices/unifi-gateway-device.js'
export { UnifiClientRegistry } from './unifi-client-registry.js'
export { buildUnifiAdoptionProvider } from './unifi-adoption-provider.js'
export { buildUnifiDeviceAdopter } from './unifi-device-adopter.js'
export { reconcileInfraFeatures } from './unifi-feature-reconcile.js'
export { UnifiInfraDevice } from './devices/unifi-infra-device.js'
export { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
