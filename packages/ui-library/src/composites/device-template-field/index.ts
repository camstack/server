export {
  DeviceTemplateField,
  type DeviceTemplateFieldHandle,
  type DeviceTemplateFieldProps,
} from './DeviceTemplateField'
export const DEVICE_TEMPLATE_DOCS_URL: string =
  'https://camstack-docs.zentik.app/docs/day-to-day/device-templates'
export {
  type DeviceTemplateAccepts,
  deviceTemplateToken,
  fieldAccepts,
  hasDeviceRefs,
  insertTemplateToken,
  carriesDeviceTemplate,
  parseTemplateSegments,
  textForDeviceCheck,
  type DeviceTemplateHeldSlots,
  type TemplateSegment,
} from './device-template-model'
