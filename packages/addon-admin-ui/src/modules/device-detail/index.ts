/**
 * The device detail module: ONE web component for a device's hero card, History
 * (with runs / cycles) and actions. Props only; mounted directly by admin-ui and
 * loaded by the viewer in a WebView. See `DeviceDetailModuleProps`.
 */
export { DeviceDetailModule } from './DeviceDetailModule'
export { useDeviceModuleNavigation } from './module-context'
export type {
  DeviceDetailModuleProps,
  DeviceModuleLocale,
  DeviceModuleNavigation,
  DeviceModuleTheme,
} from './types'
