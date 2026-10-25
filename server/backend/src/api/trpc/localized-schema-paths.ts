/**
 * The tRPC methods whose answer carries a settings schema (`ConfigUISchema`
 * or `ConfigUISchemaWithValues`) - the ONLY places the hub swaps a `labelKey`
 * for the catalog text (D863). Walking every answer would charge every call
 * for a feature one in a hundred uses; an explicit list keeps the cost where
 * the schemas are.
 *
 * A new cap method that returns a schema is added HERE (and nowhere else): a
 * schema served from a path not listed simply stays English.
 */
export const LOCALIZED_SCHEMA_PATHS: ReadonlySet<string> = new Set([
  'addonSettings.getGlobalSettings',
  'addonSettings.getIntegrationSettings',
  'addonSettings.getDeviceSettings',
  'deviceManager.getDeviceSettingsAggregate',
  'deviceManager.getDeviceLiveInfoAggregate',
  'deviceManager.getSettingsSchema',
  'deviceManager.getConfigSchema',
  'deviceManager.getCreationSchema',
  'deviceManager.providerDiscoveryParamsSchema',
  'storage.listProviders',
  'notificationOutput.listTargetKinds',
])
