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
export {
  applyTemplate,
  displayValue,
  formatClock,
  formatSlotText,
  limitText,
  truncateDecimals,
} from './format.js'
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
  DEFAULT_TICK_MS,
  type OsdCameraStatusReader,
  type OsdDeviceSummary,
  OsdManager,
  type OsdManagerDeps,
  type OsdOverlayWriter,
} from './osd-manager.js'
export { type OsdFacts, renderSlot, resolveSource } from './render.js'
export {
  isContainerDeviceType,
  isOsdLeafDeviceType,
  isOsdPickerDeviceType,
  isOsdSourceCap,
  OSD_NON_LEAF_TYPES,
  OSD_PICKER_EXCLUDED_TYPES,
  OSD_SOURCE_CAP_NAMES,
  osdStateLeavesOf,
} from './osd-source-fields.js'
export {
  deviceById,
  type OsdPickerDevice,
  osdSupportedChildrenOf,
  type SlimDeviceRow,
  toOsdPickerDevices,
} from './osd-picker-devices.js'
export { type CatalogDevice, humanizeCapName, sourceOptionsFor } from './source-catalog.js'
export { readStatePath, type StateLeaf, stateLeavesOf } from './state-leaves.js'
export { generateTemplateId, templateIdFromName } from './template-id.js'
export {
  aliasFullToken,
  aliasToken,
  bindingInsertChips,
  bindingToken,
  parseAliasStems,
  parseAliasTokens,
  type ParsedAliasToken,
  replaceToken,
  suggestAlias,
  type TemplateTokenKind,
} from './template-tokens.js'
export {
  applyTemplateFormat,
  applyTemplateTokenKind,
  type BindingLiveParts,
  expandBindingTokens,
  type NamedTemplateFacts,
  type NamedTemplateRender,
  renderNamedTemplate,
  resolveBindingLive,
} from './named-template-render.js'
export {
  convertForDisplay,
  dimensionFromSourceUnit,
  inferSourceUnit,
  type UnitDisplayResult,
} from './unit-display.js'
