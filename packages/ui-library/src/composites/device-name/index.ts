export type {
  DeviceFleetFromServerProps,
  DeviceFleetProviderProps,
  DeviceNameIndex,
} from './device-fleet'
export {
  DeviceFleetFromServer,
  DeviceFleetProvider,
  indexDeviceNames,
  useDeviceNameIndex,
} from './device-fleet'
export type { DeviceNounSpec, DeviceNameLocale } from './device-name-nouns'
export {
  DEVICE_ROLE_NOUNS,
  DEVICE_TYPE_NOUNS,
  deviceNameNouns,
  isDeviceNameStock,
  nounSpecFor,
} from './device-name-nouns'
export type {
  DeviceNameContext,
  DeviceNameFields,
  DeviceNameForm,
  DeviceNameNouns,
  DeviceNameShortNoun,
  DeviceNameStockPhrase,
} from './format-device-name'
export {
  DEVICE_NAME_FORMS,
  DEVICE_NAME_JOIN,
  foldDeviceName,
  formatDeviceName,
  sameDeviceName,
  stripDeviceParentPrefix,
} from './format-device-name'
export type { DeviceNameProps } from './DeviceName'
export { DeviceName } from './DeviceName'
export type { DeviceNameScope } from './use-device-label'
export {
  resolveDeviceLabel,
  useDeviceLabel,
  useDeviceLabelById,
  useDeviceNameNouns,
} from './use-device-label'
