/**
 * What the device page's default Config tab renders (no `sectionFilter`):
 * everything EXCEPT the sections another surface hosts — a `top-tab`
 * section (its own top-level tab), a `hero` section (under the device's hero
 * card, D915), an Export section (the Export tab), and
 * the D648 Extensions card (the Customize tab, D676 ruling 4). One predicate,
 * so each exclusion is armed by a spec rather than by a render.
 */
import type { ConfigSection, ConfigSectionWithValues, DeviceType } from '@camstack/types'
import { isDeviceExportSection } from './device-export-tab'
import { isExtensionsPanelSection, showReadOnlyExtensionsInConfig } from './extensions-section'

export function isConfigTabSection(section: ConfigSection | ConfigSectionWithValues): boolean {
  return (
    section.location !== 'top-tab' &&
    section.location !== 'hero' &&
    !isDeviceExportSection(section) &&
    !isExtensionsPanelSection(section)
  )
}

/**
 * Whether the Config top-level tab has anything to show. When the only
 * remaining Config content was the removed Identity section, Config must
 * leave the tab bar — an empty Config tab reads as broken. Pending
 * aggregate answers keep the tab (D315: not-yet-known ≠ absent).
 */
export function hasConfigTabContent(
  sections: readonly (ConfigSection | ConfigSectionWithValues)[] | undefined,
  deviceType: DeviceType | undefined,
  isAdmin: boolean,
  aggregateSettled: boolean,
): boolean {
  if (!aggregateSettled) return true
  if (showReadOnlyExtensionsInConfig(deviceType, isAdmin)) return true
  return (sections ?? []).some(isConfigTabSection)
}
