/**
 * DetectionTab — per-device detection configuration.
 *
 * Settings-redesign Phase 11: migrated from the legacy
 * `deviceManager.getActiveAddons` / `setAddonDeviceOverride`
 * path to the new three-level API via `NodeAddonsSettingsPanel` at
 * `level: 'device'`. The panel iterates
 * `PIPELINE_CLUSTER_DEVICE_ADDONS` — the same roster used by the
 * Pipeline → Device Overrides tab — so both surfaces stay in sync.
 */
import { NodeAddonsSettingsPanel } from '../../settings/NodeAddonsSettingsPanel'
import { PIPELINE_CLUSTER_DEVICE_ADDONS } from '../../pipeline/pipeline-panel-addons'

interface DetectionTabProps {
  readonly deviceId: number
}

export function DetectionTab({ deviceId }: DetectionTabProps) {
  return (
    <div className="max-w-3xl">
      <NodeAddonsSettingsPanel
        nodeId="hub"
        addonIds={PIPELINE_CLUSTER_DEVICE_ADDONS}
        level="device"
        deviceId={deviceId}
      />
    </div>
  )
}
