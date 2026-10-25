export { UnifiProviderAddon } from './addon.js'
export {
  unifiConnectionSchema,
  unifiControllerSchema,
  unifiInfraSchema,
  unifiFeatureSchema,
  unifiFeatureDescriptorSchema,
  UnifiFeatureKindSchema,
  UnifiSwitchFeatureSchema,
  UnifiButtonActionSchema,
  UnifiSensorMetricSchema,
  buildControllerFormSchema,
  settingsToConnection,
  slugifyHost,
} from './config.js'
export type {
  UnifiConnectionConfig,
  UnifiControllerConfig,
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
} from './unifi-discovery.js'
export type { ParsedNativeId } from './unifi-discovery.js'
export { buildInfraFeatures, featuresEqual, capForMetric } from './unifi-mapping.js'
export {
  UnifiIntegrationManager,
  defaultUnifiClientFactory,
} from './unifi-integration-manager.js'
export { UnifiControllerResolver, unifiControllers } from './unifi-node-resolver.js'
export { UnifiControllerDevice } from './devices/unifi-controller-device.js'
export { UnifiInfraDevice } from './devices/unifi-infra-device.js'
export { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
