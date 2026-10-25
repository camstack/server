/**
 * The rows of the camera assignment tables, as pure functions.
 *
 * Cluster → Assignments lists EVERY camera, from the camera list. An
 * assignment record exists only while a session runs (on-motion cameras) or
 * while a camera is pinned, so a table built from the records lost every
 * camera that had neither — on this hub 27 of 32. A camera with no record is
 * a row that says "no session yet", never a missing row.
 *
 * A node is NAMED, never shown by its id: the Mac mini's id is its hostname
 * (`MacMiniAgent.localdomain`) and its name is what the sidebar calls it.
 */
import type { CameraAssignmentStatus } from '@camstack/types'
import i18n from '../../../i18n/index'

/** One placeable role of a camera. */
export interface RoleState {
  /** A session (or a pin) currently holds this role somewhere. */
  readonly active: boolean
  readonly pinned: boolean
  readonly nodeId: string | null
  /** The orchestrator's reason for an automatic placement (`capacity`, …). */
  readonly reason: string
}

export const INACTIVE_ROLE: RoleState = { active: false, pinned: false, nodeId: null, reason: '' }

export interface AssignmentCamera {
  readonly id: number
  readonly name: string
  readonly disabled?: boolean
}

export interface PipelineAssignmentRecord {
  readonly deviceId: number
  readonly agentNodeId: string
  readonly pinned: boolean
  readonly reason?: string
}

export interface AudioAssignmentRecord {
  readonly deviceId: number
  readonly nodeId: string
  readonly pinned: boolean
}

export interface ClusterAssignmentRow {
  readonly deviceId: number
  readonly deviceName: string
  readonly disabled: boolean
  /** Placement editor + resolved node — from assignment records, not live dispatch. */
  readonly pipeline: RoleState
  /** Live (or record) placement for Roles here pills. */
  readonly detection: RoleState
  readonly decoder: RoleState
  readonly audio: RoleState
}

/** Locale order by name, then id — a stable order the operator can scan. */
function byName(a: { deviceName: string; deviceId: number }, b: typeof a): number {
  return a.deviceName.localeCompare(b.deviceName) || a.deviceId - b.deviceId
}

/**
 * One row per camera of the camera list, with its pipeline and audio records
 * folded in. A record for a device that is not in the list (deleted, or the
 * list not loaded yet) adds no row: the table answers "which camera runs
 * where", and a row named "Device 3836" answers nothing.
 */
export function buildClusterAssignmentRows(
  cameras: readonly AssignmentCamera[],
  pipeline: readonly PipelineAssignmentRecord[],
  audio: readonly AudioAssignmentRecord[],
): readonly ClusterAssignmentRow[] {
  const pipelineById = new Map(pipeline.map((a) => [a.deviceId, a]))
  const audioById = new Map(audio.map((a) => [a.deviceId, a]))
  return cameras
    .map((camera): ClusterAssignmentRow => {
      const p = pipelineById.get(camera.id)
      const a = audioById.get(camera.id)
      const pipeline = p
        ? { active: true, pinned: p.pinned, nodeId: p.agentNodeId, reason: p.reason ?? '' }
        : INACTIVE_ROLE
      const audioRole = a
        ? { active: true, pinned: a.pinned, nodeId: a.nodeId, reason: '' }
        : INACTIVE_ROLE
      return {
        deviceId: camera.id,
        deviceName: camera.name,
        disabled: camera.disabled === true,
        pipeline,
        detection: pipeline,
        decoder: INACTIVE_ROLE,
        audio: audioRole,
      }
    })
    .toSorted(byName)
}

export interface NodeAssignmentRow {
  readonly deviceId: number
  readonly deviceName: string
  readonly detection: RoleState
  readonly decoder: RoleState
  readonly audio: RoleState
}

interface CameraStatusAssignment {
  readonly deviceId: number
  readonly assignment: CameraAssignmentStatus
}

function roleFromAssignment(nodeId: string | null, pinned: boolean, reason?: string): RoleState {
  return {
    active: nodeId !== null,
    pinned,
    nodeId,
    reason: reason ?? '',
  }
}

/** Fold live `getCameraStatuses` placement into cluster rows for Roles here. */
export function enrichClusterRowsWithCameraStatuses(
  rows: readonly ClusterAssignmentRow[],
  statuses: readonly CameraStatusAssignment[],
): readonly ClusterAssignmentRow[] {
  const byDevice = new Map(statuses.map((s) => [s.deviceId, s.assignment]))
  return rows.map((row) => {
    const assignment = byDevice.get(row.deviceId)
    if (assignment === undefined) return row
    return {
      ...row,
      detection: roleFromAssignment(
        assignment.detectionNodeId,
        assignment.pinned.detection,
        assignment.reasons.detection,
      ),
      decoder: roleFromAssignment(
        assignment.decoderNodeId,
        assignment.pinned.decoder,
        assignment.reasons.decoder,
      ),
      audio: roleFromAssignment(
        assignment.audioNodeId,
        assignment.pinned.audio,
        assignment.reasons.audio,
      ),
    }
  })
}

/**
 * A node's rows: the cameras whose CURRENT placement (`getCameraStatuses`)
 * puts at least one role on this node. A persisted record pointing here for a
 * camera that is not dispatched here (an on-motion camera between sessions, a
 * stale pin) must not produce a row.
 */
export function buildNodeAssignmentRows(
  nodeId: string,
  statuses: readonly CameraStatusAssignment[],
  nameOf: (deviceId: number) => string,
): readonly NodeAssignmentRow[] {
  const role = (roleNodeId: string | null, pinned: boolean, reason?: string): RoleState => ({
    active: roleNodeId !== null && roleNodeId === nodeId,
    pinned,
    nodeId: roleNodeId,
    reason: reason ?? '',
  })
  return statuses
    .map(
      ({ deviceId, assignment }): NodeAssignmentRow => ({
        deviceId,
        deviceName: nameOf(deviceId),
        detection: role(
          assignment.detectionNodeId,
          assignment.pinned.detection,
          assignment.reasons.detection,
        ),
        decoder: role(
          assignment.decoderNodeId,
          assignment.pinned.decoder,
          assignment.reasons.decoder,
        ),
        audio: role(assignment.audioNodeId, assignment.pinned.audio, assignment.reasons.audio),
      }),
    )
    .filter((row) => row.detection.active || row.decoder.active || row.audio.active)
    .toSorted(byName)
}

interface NamedNode {
  readonly id: string
  readonly name: string
}

/** `nodeId → display name`, falling back to the id for a node the roster does not know. */
export function nodeNamer(nodes: readonly NamedNode[]): (nodeId: string) => string {
  const byId = new Map(nodes.map((n) => [n.id, n.name]))
  return (nodeId) => {
    const name = byId.get(nodeId)
    return name !== undefined && name !== '' ? name : nodeId
  }
}

/** `deviceId → camera name`, falling back to `Camera <id>` for one the list does not hold. */
export function cameraNamer(cameras: readonly AssignmentCamera[]): (deviceId: number) => string {
  const byId = new Map(cameras.map((c) => [c.id, c.name]))
  return (deviceId) =>
    byId.get(deviceId) ?? i18n.t('helpers.assignmentRows.cameraFallback', { id: deviceId })
}

/**
 * What the "Auto | Pin" select offers: Auto, the camera's own node (even
 * offline — a pin to it must stay visible), then every online node, by name.
 */
export function nodePinOptions(
  state: RoleState,
  onlineNodes: readonly NamedNode[],
  nameOf: (nodeId: string) => string,
): readonly { readonly value: string; readonly label: string }[] {
  const ids = [
    ...new Set([...(state.nodeId !== null ? [state.nodeId] : []), ...onlineNodes.map((n) => n.id)]),
  ]
  return [
    { value: 'auto', label: i18n.t('helpers.assignmentRows.auto') },
    ...ids.map((id) => ({
      value: id,
      label: i18n.t('helpers.assignmentRows.pinTo', { node: nameOf(id) }),
    })),
  ]
}
