/**
 * DetectionPipelineTab — the single consolidated "Detection pipeline" device
 * tab, ONE tab bar: Steps, then the settings groups (Zones, Object detection,
 * Tracking, Motion, Stationary, Audio, Cluster — see
 * `detection-settings-groups`).
 *
 *   - "Steps" (default) — the camera's step tree (D927, `CameraStepInspector`).
 *   - the groups — every detection settings panel the pipeline addons
 *     contribute, rendered by `DeviceAggregateSection` filtered to the
 *     detection top-tab sections. A group with no sections for this camera is
 *     not shown. Steps is a leading tab of the same form, so all groups share
 *     one save controller and unsaved edits accumulate across tabs.
 *
 * The active tab is the shared `?sub=` URL param (a tab id: `steps`,
 * `zones`, `object-detection` …) so a refresh restores it. The legacy
 * `?sub=settings` opens `object-detection`.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigSectionWithValues } from '../../../types/config-ui'
import { DeviceAggregateSection } from './DeviceAggregateSection'
import { CameraStepInspector } from './CameraStepInspector'
import { SETTINGS_GROUP_TABS, groupOfSettingsSection } from './detection-settings-groups'

const TAB_STEPS = 'steps'
const LEGACY_SETTINGS = 'settings'
const LEGACY_SETTINGS_TARGET = 'object-detection'

interface DetectionPipelineTabProps {
  readonly deviceId: number
  /** Controlled tab id + change handler, threaded from DeviceDetail (`?sub=`). */
  readonly activeSubTab?: string | null
  readonly onSubTabChange?: (id: string) => void
}

/**
 * The detection settings sections the pipeline addons contribute as
 * `location: 'top-tab'` — the `detection-pipeline` sections (detector /
 * tracking / motion / stationary) plus the `zones` sections.
 */
function isDetectionSettingsSection(section: ConfigSectionWithValues): boolean {
  return (
    section.location === 'top-tab' &&
    (section.tab === 'detection-pipeline' || section.tab === 'zones')
  )
}

const SUB_TAB_GROUPING = {
  groupOf: (section: ConfigSectionWithValues): string => groupOfSettingsSection(section.id),
  tabs: SETTINGS_GROUP_TABS,
}

export function DetectionPipelineTab({
  deviceId,
  activeSubTab,
  onSubTabChange,
}: DetectionPipelineTabProps) {
  const { t } = useTranslation()
  const leadingTabs = useMemo(
    () => [
      {
        id: TAB_STEPS,
        label: t('device.detectionPipelineTab.steps', 'Steps'),
        content: <CameraStepInspector deviceId={deviceId} />,
      },
    ],
    [deviceId, t],
  )
  const active = activeSubTab === LEGACY_SETTINGS ? LEGACY_SETTINGS_TARGET : activeSubTab

  return (
    <DeviceAggregateSection
      deviceId={deviceId}
      sectionFilter={isDetectionSettingsSection}
      subTabGrouping={SUB_TAB_GROUPING}
      leadingTabs={leadingTabs}
      activeSubTab={active}
      onSubTabChange={onSubTabChange}
    />
  )
}
