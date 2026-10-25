/**
 * DetectionPipelineTab — the single consolidated "Detection pipeline" device
 * tab. It folds the two formerly-separate detection surfaces into ONE top tab
 * with two sub-tabs, so every detection concern for a camera lives under one
 * roof:
 *
 *   1. "Steps"    — the camera's step tree (D927, `CameraStepInspector`):
 *                   On / Off / Auto per step, camera-semantic settings.
 *   2. "Settings" — every detection settings panel the pipeline addons
 *                   contribute (detector macro / confidence / NMS, the
 *                   Tracking form incl. dedup / class-voting / confirmation /
 *                   per-class-confidence knobs, motion, stationary, zones …),
 *                   rendered by `DeviceAggregateSection` filtered to the
 *                   detection top-tab sections and grouped into concern-scoped
 *                   second-level sub-tabs (see `detection-settings-groups`).
 *
 * This is a pure RE-LAYOUT: both sub-tabs render the exact same components,
 * cap methods and stores they used when they were two separate top tabs —
 * nothing about read/write wiring changed.
 *
 * The active sub-tab is controlled via the shared `?sub=` URL param
 * (`activeSubTab`/`onSubTabChange`) so a refresh/remount restores it, mirroring
 * every other inner-tab surface on the device-detail page.
 */
import { useCallback } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@camstack/ui-library'
import type { ConfigSectionWithValues } from '../../../types/config-ui'
import { DeviceAggregateSection } from './DeviceAggregateSection'
import { CameraStepInspector } from './CameraStepInspector'
import { SETTINGS_GROUP_TABS, groupOfSettingsSection } from './detection-settings-groups'
import { useTranslation } from 'react-i18next'

const SUB_STEPS = 'steps'
const SUB_SETTINGS = 'settings'
const VALID_SUBS: ReadonlySet<string> = new Set([SUB_STEPS, SUB_SETTINGS])

interface DetectionPipelineTabProps {
  readonly deviceId: number
  /**
   * Controlled sub-tab id + change handler, threaded from DeviceDetail so the
   * Steps/Settings selection persists in the `?sub=` URL param. Unset defaults
   * to the Steps sub-tab.
   */
  readonly activeSubTab?: string | null
  readonly onSubTabChange?: (id: string) => void
}

/**
 * Section predicate for the Settings sub-tab. Matches the detection settings
 * sections the pipeline addons contribute as `location: 'top-tab'` — the
 * `detection-pipeline` sections (detector / tracking / motion / stationary)
 * plus the `zones` sections folded in alongside them. This is the same filter
 * the standalone "Detection pipeline" top tab used before consolidation.
 */
function isDetectionSettingsSection(section: ConfigSectionWithValues): boolean {
  return (
    section.location === 'top-tab' &&
    (section.tab === 'detection-pipeline' || section.tab === 'zones')
  )
}

export function DetectionPipelineTab({
  deviceId,
  activeSubTab,
  onSubTabChange,
}: DetectionPipelineTabProps) {
  const { t } = useTranslation()
  const active = activeSubTab && VALID_SUBS.has(activeSubTab) ? activeSubTab : SUB_STEPS
  const handleValueChange = useCallback(
    (next: string) => {
      onSubTabChange?.(next)
    },
    [onSubTabChange],
  )

  return (
    <Tabs value={active} onValueChange={handleValueChange} className="flex flex-col">
      <TabsList className="flex-shrink-0">
        <TabsTrigger value={SUB_STEPS}>
          {t('device.detectionPipelineTab.steps', 'Steps')}
        </TabsTrigger>
        <TabsTrigger value={SUB_SETTINGS}>
          {t('device.detectionPipelineTab.settings', 'Settings')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value={SUB_STEPS}>
        <CameraStepInspector deviceId={deviceId} />
      </TabsContent>

      <TabsContent value={SUB_SETTINGS}>
        {/* Group the contributed detection sections into concern-scoped
            second-level sub-tabs (Object detection / Tracking / Motion /
            Stationary / Zones / Audio / Cluster) instead of one long flat
            column. All groups share one save controller (TabbedSettingsForm),
            so unsaved edits accumulate across group tabs. Unmapped sections
            fall through to the default group — nothing disappears. */}
        <DeviceAggregateSection
          deviceId={deviceId}
          sectionFilter={isDetectionSettingsSection}
          subTabGrouping={{
            groupOf: (section) => groupOfSettingsSection(section.id),
            tabs: SETTINGS_GROUP_TABS,
          }}
        />
      </TabsContent>
    </Tabs>
  )
}
