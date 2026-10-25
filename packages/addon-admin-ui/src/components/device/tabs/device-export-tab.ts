/**
 * device-export aggregator helpers — shared between `DeviceDetail` (which
 * surfaces the Export top-level tab) and `DeviceAggregateSection` (which
 * filters export sections OUT of the default Config view and renders
 * them when explicitly requested).
 *
 * `device-export` is a collection cap (HAP / Alexa / HA-MQTT) where every
 * provider contributes a per-device section via the framework
 * `getDeviceSettingsContribution(deviceId)` method. The contributions
 * already declare `tab: 'export'` + a tab declaration with `order: 80`,
 * but they default to `location: 'settings'` — which would render them
 * under the Config tab. We hoist them client-side into a dedicated
 * top-level "Export" tab without touching the cap or any addon.
 *
 * Detection rule — the SECTION's own declaration first, the field tags
 * second:
 *
 *   1. `section.tab === 'export'` — what every device-export contributor
 *      already declares, alongside the matching `tabs[]` entry.
 *   2. any field tagged `writerCapName === 'device-export'` (injected by
 *      the device-manager aggregator) — the fallback for a contributor
 *      that omits the tab.
 *
 * Rule 1 was added after rule 2 alone put the same cap's sections in two
 * different tabs. `tagField` (device-aggregation-merge.ts) deliberately
 * skips structural field types — `separator` / `info` / `button` have no
 * writer to route a patch back to — so a device-export provider whose
 * contribution is currently ONLY an `info` placeholder ("Not configured",
 * "no instance enabled yet") carried no marker at all. Alexa and HomeKit
 * were hoisted because they have editable fields; Home Assistant's
 * placeholder-only section fell through to Config → Export. Placement must
 * not depend on whether an addon happens to have something to configure
 * yet, so it is read from what the contributor DECLARES.
 */
import type {
  ConfigField,
  ConfigFieldWithValue,
  ConfigSection,
  ConfigSectionWithValues,
} from '@camstack/types'

export const DEVICE_EXPORT_CAP_NAME = 'device-export'
export const DEVICE_EXPORT_TAB_ID = 'export'
export const DEVICE_EXPORT_TAB_LABEL = 'Export'
/** Mirrors the `tabs[].order` declared by every device-export addon. */
export const DEVICE_EXPORT_TAB_ORDER = 80

/**
 * Recursively walk a field tree looking for a `writerCapName === 'device-export'`
 * marker. Returns true on the first match so callers can short-circuit.
 *
 * The discriminated union for `ConfigField` covers both the raw (no-value)
 * and the hydrated (with-value) shapes — the marker lives on
 * `ConfigFieldBase`, so it's visible on either branch. We accept the union
 * `ConfigField | ConfigFieldWithValue` so a single helper serves both
 * call sites.
 */
function fieldCarriesExportWriter(field: ConfigField | ConfigFieldWithValue): boolean {
  // Structural variants (separator/info/object-array/widget/addon-action-button)
  // never carry writer metadata. Narrowing by `type` avoids casts.
  if (
    field.type === 'separator' ||
    field.type === 'info' ||
    field.type === 'object-array' ||
    field.type === 'widget' ||
    field.type === 'addon-action-button' ||
    field.type === 'device-action-button'
  ) {
    return false
  }
  if (field.type === 'group') {
    return field.fields.some(fieldCarriesExportWriter)
  }
  if (field.type === 'sub-tabs') {
    return field.tabs.some((tab) => tab.fields.some(fieldCarriesExportWriter))
  }
  return field.writerCapName === DEVICE_EXPORT_CAP_NAME
}

/**
 * True when the section belongs to the device's top-level Export tab. Used
 * to (a) hoist it there from `DeviceDetail` and (b) exclude it from the
 * default Config tab so it doesn't render twice.
 *
 * A section qualifies when it DECLARES the export tab, or — fallback — when
 * any of its fields carries the `device-export` writer tag. See the module
 * docblock for why the declaration has to come first.
 */
export function isDeviceExportSection(section: ConfigSection | ConfigSectionWithValues): boolean {
  if (section.tab === DEVICE_EXPORT_TAB_ID) return true
  return section.fields.some(fieldCarriesExportWriter)
}
