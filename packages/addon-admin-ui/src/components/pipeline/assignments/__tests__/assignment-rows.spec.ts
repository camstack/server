import { describe, expect, it } from 'vitest'
import {
  buildClusterAssignmentRows,
  cameraNamer,
  enrichClusterRowsWithCameraStatuses,
  nodeNamer,
  nodePinOptions,
} from '../assignment-rows'

const CAMERAS = [
  { id: 3836, name: 'Camera studio' },
  { id: 103, name: 'Camera porch' },
  { id: 107, name: 'Camera Carol', disabled: true },
]

describe('buildClusterAssignmentRows', () => {
  it('is one row per camera of the LIST, records folded in, sorted by name', () => {
    const rows = buildClusterAssignmentRows(
      CAMERAS,
      [{ deviceId: 3836, agentNodeId: 'hub', pinned: false, reason: 'capacity' }],
      [{ deviceId: 103, nodeId: 'agent-a', pinned: true }],
    )
    expect(rows.map((r) => r.deviceId)).toEqual([107, 103, 3836])
    expect(rows.find((r) => r.deviceId === 3836)?.pipeline).toEqual({
      active: true,
      pinned: false,
      nodeId: 'hub',
      reason: 'capacity',
    })
    // No record: a row with nothing placed (audit B3), not a missing row.
    expect(rows.find((r) => r.deviceId === 103)?.pipeline.nodeId).toBeNull()
    expect(rows.find((r) => r.deviceId === 103)?.audio.pinned).toBe(true)
    expect(rows.find((r) => r.deviceId === 107)?.disabled).toBe(true)
    expect(rows.find((r) => r.deviceId === 3836)?.decoder.active).toBe(false)
  })

  it('folds live camera statuses into detection, decoder and audio for Roles here', () => {
    const base = buildClusterAssignmentRows(CAMERAS, [], [])
    const rows = enrichClusterRowsWithCameraStatuses(base, [
      {
        deviceId: 3836,
        assignment: {
          detectionNodeId: 'hub',
          decoderNodeId: 'agent-a',
          audioNodeId: null,
          sourceNodeId: null,
          pinned: { detection: false, decoder: true, audio: false },
          reasons: { detection: 'capacity', decoder: 'co-located' },
        },
      },
    ])
    const row = rows.find((r) => r.deviceId === 3836)
    expect(row?.detection.nodeId).toBe('hub')
    expect(row?.decoder).toEqual({
      active: true,
      pinned: true,
      nodeId: 'agent-a',
      reason: 'co-located',
    })
    expect(row?.pipeline.nodeId).toBeNull()
  })

  it('adds no row for a record whose device is not in the list', () => {
    const rows = buildClusterAssignmentRows(
      CAMERAS,
      [{ deviceId: 9999, agentNodeId: 'hub', pinned: true }],
      [],
    )
    expect(rows.map((r) => r.deviceId)).not.toContain(9999)
  })
})

describe('names', () => {
  it('names a node by its display name, falling back to the id', () => {
    const nameOf = nodeNamer([{ id: 'MacMiniAgent.localdomain', name: 'macmini' }])
    expect(nameOf('MacMiniAgent.localdomain')).toBe('macmini')
    expect(nameOf('gone')).toBe('gone')
  })

  it('names a camera, falling back to "Camera <id>"', () => {
    const nameOf = cameraNamer(CAMERAS)
    expect(nameOf(3836)).toBe('Camera studio')
    expect(nameOf(1)).toBe('Camera 1')
  })

  it('offers Auto, the camera node (even offline) and every online node, by name', () => {
    const nameOf = nodeNamer([
      { id: 'hub', name: 'Hub' },
      { id: 'mac', name: 'macmini' },
    ])
    const options = nodePinOptions(
      { active: true, pinned: true, nodeId: 'mac', reason: '' },
      [{ id: 'hub', name: 'Hub' }],
      nameOf,
    )
    expect(options.map((o) => o.label)).toEqual(['Auto', 'Pin → macmini', 'Pin → Hub'])
  })
})
