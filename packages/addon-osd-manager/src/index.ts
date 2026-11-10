export { OsdManagerAddon, OsdManagerAddon as default } from './addon.js'
export {
  type DeviceStateFactory,
  type DurableStateLike,
  OsdBindingsStore,
} from './bindings-handle.js'
export {
  type BindingsHandle,
  EMPTY_BINDINGS,
  OSD_BINDINGS_KEY,
  type OsdDeviceBindings,
  OsdDeviceBindingsSchema,
  withBinding,
  withoutBinding,
} from './bindings-store.js'
export { limitText } from './format.js'
export {
  assertSupportedConditions,
  evaluateGate,
  OSD_SUPPORTED_CONDITIONS,
  type OsdDeviceStateLookup,
  type OsdGateInput,
  type OsdGateResult,
  unsupportedConditionKeys,
} from './gate.js'
export {
  CLOCK_RERENDER_MS,
  DEFAULT_TICK_MS,
  type OsdCameraStatusReader,
  type OsdDeviceSummary,
  OsdManager,
  type OsdManagerDeps,
  type OsdOverlayWriter,
  SLOT_RERENDER_THROTTLE_MS,
} from './osd-manager.js'
export { type OsdFacts, renderSlot } from './render.js'
export { generateTemplateId, templateIdFromName } from './template-id.js'
export {
  mentionsRecognition,
  type OsdTemplateCheck,
  type OsdTemplateRenderInput,
  outcomeOfRender,
  RECOGNITION_VALUE_NAMES,
  type TemplateOutcome,
} from './template-context.js'
