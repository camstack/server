/**
 * Cluster → Assignments — WHICH camera runs WHERE: every camera, its node and
 * accelerator pins, the node it runs on and its live status, in one table.
 * How much each node carries (load, shares, caps, Rebalance) is the Load
 * balancing tab's (D748).
 */
import { CameraAssignmentsTable } from '../CameraAssignmentsTable'
import { useTranslation } from 'react-i18next'

export function ClusterAssignmentsTab() {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-foreground">
          {t('pipeline.clusterAssignmentsTab.cameraPlacement', 'Camera placement')}
        </h3>
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterAssignmentsTab.pinACameraToA',
            'Pin a camera to a node, or to one accelerator of its node; Auto lets each session pick. Decode always runs with detection. Load, shares and caps are on Load balancing.',
          )}
        </p>
      </div>
      <CameraAssignmentsTable />
    </div>
  )
}
