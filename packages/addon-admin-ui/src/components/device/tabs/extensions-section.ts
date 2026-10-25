/**
 * Where the D648 Extensions card is shown (D676 ruling 4). Its only host type
 * is the camera, and on a camera the Customize tab now carries both halves —
 * `linked-devices` in Links, the doorbell in the Doorbell card — so the card
 * leaves the Config tab. The cap, both slots and both owners stay; their
 * deletion is slice 6. Detected by the widget id, the same way
 * `device-export-tab.ts` detects its sections: from what is declared.
 */
import {
  type ConfigField,
  type ConfigFieldWithValue,
  type ConfigSection,
  type ConfigSectionWithValues,
  type DeviceType,
  EXTENSION_HOST_DEVICE_TYPES,
} from '@camstack/types'

export const EXTENSIONS_PANEL_WIDGET_ID = 'host/extensions-panel'

function fieldIsExtensionsPanel(field: ConfigField | ConfigFieldWithValue): boolean {
  if (field.type === 'widget') return field.widgetId === EXTENSIONS_PANEL_WIDGET_ID
  if (field.type === 'group') return field.fields.some(fieldIsExtensionsPanel)
  if (field.type === 'sub-tabs')
    return field.tabs.some((tab) => tab.fields.some(fieldIsExtensionsPanel))
  return false
}

export function isExtensionsPanelSection(
  section: ConfigSection | ConfigSectionWithValues,
): boolean {
  return section.fields.some(fieldIsExtensionsPanel)
}

/**
 * L4 (final review, D676): the Extensions card left Config for EVERYONE, but
 * its new home (Customize) is admin-only (ruling 1) — `deviceExtension.listSlots`
 * is `protected`, so a non-admin used to see linked devices and doorbell
 * sources and would otherwise see them nowhere. Shown READ-ONLY on Config for
 * whoever cannot open Customize; an admin keeps it there only, never twice.
 */
export function showReadOnlyExtensionsInConfig(
  deviceType: DeviceType | undefined,
  isAdmin: boolean,
): boolean {
  return !isAdmin && deviceType !== undefined && EXTENSION_HOST_DEVICE_TYPES.includes(deviceType)
}
