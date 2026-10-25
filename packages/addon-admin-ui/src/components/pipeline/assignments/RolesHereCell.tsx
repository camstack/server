import type { NodeColorId } from '@camstack/types'
import { RoleNodePill, type PipelineRoleId } from '@camstack/ui-library'
import type { RoleState } from './assignment-rows'
import { colorIdForNode } from './node-color-map'

interface RolePillSlotProps {
  readonly roleId: PipelineRoleId
  readonly roleLabel: string
  readonly state: RoleState
  readonly nameOf: (nodeId: string) => string
  readonly colorByNodeId: ReadonlyMap<string, NodeColorId>
  readonly emphasizeOnNodeId?: string
}

function RolePillSlot({
  roleId,
  roleLabel,
  state,
  nameOf,
  colorByNodeId,
  emphasizeOnNodeId,
}: RolePillSlotProps) {
  if (state.nodeId === null) return null
  const nodeId = state.nodeId
  const emphasized =
    emphasizeOnNodeId !== undefined ? state.active && nodeId === emphasizeOnNodeId : false
  return (
    <RoleNodePill
      roleId={roleId}
      roleLabel={roleLabel}
      nodeName={nameOf(nodeId)}
      colorId={colorIdForNode(colorByNodeId, nodeId)}
      emphasized={emphasized}
      pinned={state.pinned}
    />
  )
}

export interface RolesHereCellProps {
  readonly detection: RoleState
  readonly decoder: RoleState
  readonly audio: RoleState
  readonly nameOf: (nodeId: string) => string
  readonly colorByNodeId: ReadonlyMap<string, NodeColorId>
  /** When set, pills for roles active on this node render with stronger chrome. */
  readonly emphasizeOnNodeId?: string
}

export function RolesHereCell({
  detection,
  decoder,
  audio,
  nameOf,
  colorByNodeId,
  emphasizeOnNodeId,
}: RolesHereCellProps) {
  const slot = (roleId: PipelineRoleId, roleLabel: string, state: RoleState) => (
    <RolePillSlot
      key={roleId}
      roleId={roleId}
      roleLabel={roleLabel}
      state={state}
      nameOf={nameOf}
      colorByNodeId={colorByNodeId}
      emphasizeOnNodeId={emphasizeOnNodeId}
    />
  )
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {slot('detection', 'Detection', detection)}
      {slot('decode', 'Decode', decoder)}
      {slot('audio', 'Audio', audio)}
    </div>
  )
}
