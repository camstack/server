export { createApiDeviceGateway, type DeviceGateway } from './device-gateway.js'
export { default, ExportGoogleAddon } from './export-google.addon.js'
export {
  type FulfillmentDeps,
  type FulfillmentResult,
  handleFulfillment,
  type VerifiedGoogleCaller,
} from './fulfillment-router.js'
export {
  buildSyncDevice,
  type ExportableDeviceFacts,
  resolveGoogleDeviceType,
  SUPPORTED_DEVICE_KINDS,
} from './google-home/device-model.js'
export {
  type CapCall,
  type CapStatusRead,
  type CommandResolution,
  EXPORTED_CAP_NAMES,
  statesAfterCall,
  TRAIT_CATALOG,
  type TraitDescriptor,
  traitForCommand,
  traitsForCaps,
} from './google-home/trait-catalog.js'
export { buildGoogleOauthIntegration } from './oauth-integration.js'
