/**
 * The device page's STRUCTURAL tabs — bespoke content, not driven by the
 * settings schema — extracted from `DeviceDetail.tsx` (D676) so the table and
 * its filters are one pure function a spec can pin.
 */
import { DeviceType } from '@camstack/types'
import { CUSTOMIZE_TAB_ID } from '../../../lib/customization-routes'
import i18n from '../../../i18n/index'

export interface StructuralTab {
  readonly id: string
  readonly label: string
}

// Phase 6 Option B: the per-camera Pipeline editor is contributed as a
// `pipeline-editor` ConfigField by `pipeline-orchestrator`'s
// `getDeviceSettingsContribution`. It surfaces automatically inside
// the Config tab aggregator under the "Pipeline" sub-tab — no
// dedicated top-level tab needed.
//
// Structural tabs are hardcoded (overview/config/pipeline/bindings)
// — each has bespoke React content not driven by the settings schema.
// Addon-contributed top tabs (e.g. Zones, Recording) are discovered at
// render time from sections marked `location: 'top-tab'` in the device
// aggregate — Recording is provisioned by the recorder addon as the
// `host/recording-panel` widget, no longer a structural tab.
// REPL is no longer a fixed tab — use the floating REPL panel (Terminal
// icon in the device header) which exposes the new SystemMirror-backed
// `device` proxy + examples.
// Structural tabs are filtered per device type at render time. Camera
// devices see the full set; non-camera devices (Switch / Sensor /
// Light / Button / Hub / Generic) only see Overview + Config because
// Pipeline / Recording / Bindings are camera-only concerns. The same
// filter promotes the Page-grid status column to the only place where
// non-camera devices show their identity-level info.
// The `detection-pipeline` tab is a STRUCTURAL camera tab (always present for
// cameras) even though addons also contribute detection settings sections
// tagged `tab: 'detection-pipeline'` / `tab: 'zones'`. Declaring it here (first
// in the dedup pass) means the structural entry always wins the id collision,
// so the addon-contributed "Detection pipeline" tab folds into this one tab
// instead of appearing twice. Its body (`DetectionPipelineTab`) hosts BOTH the
// #33 Steps editor and those contributed Settings sections as two sub-tabs.
// `customize` (D676) is structural for the same reason the others are: bespoke
// content not driven by the settings schema. It exists on EVERY device type and
// only for admins — every `coreBlocks.*` method it calls is admin-only. It sits
// right after Config.
/** The device page's History tab id (`?tab=history`). */
export const HISTORY_TAB_ID = 'history'

// `history` (D899) is structural on every REAL device: its body is the
// library's `DeviceHistoryView`, not a schema, and device-history records
// nothing for a hub or a container (D850), so neither gets the tab.
const STRUCTURAL_TABS_ALL = [
  {
    id: 'overview',
    labelKey: 'helpers.structuralTabs.overview',
    cameraOnly: false,
    adminOnly: false,
  },
  { id: 'config', labelKey: 'helpers.structuralTabs.config', cameraOnly: false, adminOnly: false },
  {
    id: CUSTOMIZE_TAB_ID,
    labelKey: 'helpers.structuralTabs.customize',
    cameraOnly: false,
    adminOnly: true,
  },
  {
    id: HISTORY_TAB_ID,
    labelKey: 'helpers.structuralTabs.history',
    cameraOnly: false,
    adminOnly: false,
  },
  {
    id: 'detection-pipeline',
    labelKey: 'helpers.structuralTabs.detectionPipeline',
    cameraOnly: true,
    adminOnly: false,
  },
  {
    id: 'bindings',
    labelKey: 'helpers.structuralTabs.bindings',
    cameraOnly: true,
    adminOnly: false,
  },
  // There was another: `wiring`. It rendered on essentially every device,
  // offered `device-status.online` and `feature-probe.*` as its only targets,
  // and a month after shipping had produced 0 links across 302 devices —
  // it read as broken rather than as unused. Removed with the mechanism on
  // 2026-08-08; device customization now lives in `customize` (D676), and a
  // `?tab=wiring` link falls through to the device's default tab.
] as const

/** Device types device-history never records (D850): not a real device. */
const NOT_RECORDED_TYPES: ReadonlySet<string> = new Set([DeviceType.Hub, DeviceType.Container])

export function structuralTabsFor(
  deviceType: string | undefined,
  isAdmin: boolean,
): readonly StructuralTab[] {
  const isCamera = deviceType === DeviceType.Camera
  const recorded = deviceType === undefined || !NOT_RECORDED_TYPES.has(deviceType)
  return STRUCTURAL_TABS_ALL.filter(
    (t) =>
      (isCamera || !t.cameraOnly) &&
      (isAdmin || !t.adminOnly) &&
      (recorded || t.id !== HISTORY_TAB_ID),
  ).map(({ id, labelKey }) => ({ id, label: i18n.t(labelKey) }))
}
