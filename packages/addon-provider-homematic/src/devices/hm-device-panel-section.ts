import type { ConfigSectionWithValues } from '@camstack/types'

/** `<addonId>/<stableId>` of the device panel in this addon's widget bundle. */
export const HM_DEVICE_PANEL_WIDGET_ID = 'provider-homematic/device-panel'

const NS = 'provider-homematic:device.panel'

/**
 * The device page section of one CCU device: the Homematic panel widget
 * (values, diagnostics, manual actuation, MASTER configuration). The widget
 * stores nothing in CamStack — it reads and writes the CCU through the
 * addon's confirmed custom actions.
 */
export function devicePanelSection(
  integrationId: string,
  address: string,
): ConfigSectionWithValues {
  return {
    id: 'homematic-device',
    title: 'Homematic',
    titleKey: `${NS}.title`,
    tab: 'general',
    order: 5,
    columns: 1,
    fields: [
      {
        type: 'widget',
        key: '_homematicDevicePanel',
        label: '',
        widgetId: HM_DEVICE_PANEL_WIDGET_ID,
        widgetConfig: { integrationId, address },
      },
    ],
  }
}
