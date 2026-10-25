export type {
  ExtensionSlotCardinality,
  ExtensionSlotDescriptor,
  ExtensionSlotShape,
} from './slot-descriptor.js'
export {
  createDeviceExtensionProvider,
  defineExtensionSlotProvider,
  extensionSlotRef,
  type DeviceExtensionProviderOptions,
  type ExtensionSlotImpl,
  type ExtensionSlotListing,
  type ExtensionSlotProvider,
  type ExtensionSlotValueOf,
} from './slot-provider.js'
export {
  EXTENSION_HOST_DEVICE_TYPES,
  EXTENSION_SLOT_IDS,
  EXTENSION_SLOTS,
  ExtensionSlotIdSchema,
  ExtensionSlotValueSchema,
  type ExtensionSlotEntry,
  type ExtensionSlotId,
  type ExtensionSlotValue,
} from '../generated/extension-slots.js'
