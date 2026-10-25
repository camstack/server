/**
 * node → Assignments: the node's live load, and the cameras that run on it
 * right now with the roles each holds here (`NodeCameraAssignmentsTable`).
 */
import { useClusterNodes } from '@camstack/ui-library'
import { LiveLoadPanel } from '../LiveLoadPanel'
import { NodeCameraAssignmentsTable } from '../NodeCameraAssignmentsTable'
import { useTranslation } from 'react-i18next'

interface NodeCamerasTabProps {
  readonly nodeId: string
  readonly refreshToken: number
}

export function NodeCamerasTab({ nodeId, refreshToken }: NodeCamerasTabProps) {
  const { t } = useTranslation()
  const { nodes } = useClusterNodes()
  const name = nodes.find((n) => n.id === nodeId)?.name ?? nodeId
  return (
    <div className="space-y-3 sm:space-y-4">
      <LiveLoadPanel refreshToken={refreshToken} nodeId={nodeId} />
      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            {t('pipeline.nodeCamerasTab.camerasOn', { node: name })}
          </h3>
          <p className="text-[11px] text-foreground-subtle">
            {t(
              'pipeline.nodeCamerasTab.theRolesEachCameraRuns',
              'The roles each camera runs here right now. Move a role or unpin it from the row menu; pins for every camera are on Cluster → Assignments.',
            )}
          </p>
        </div>
        <NodeCameraAssignmentsTable nodeId={nodeId} />
      </div>
    </div>
  )
}
