/**
 * WHERE a track was detected, as the detail panel says it: one "Detected on"
 * row when the track opened and closed on the same node/device/model, two rows
 * when the camera's session hopped mid-track (D916), and NOTHING when the row
 * names no placement — an absent placement is unknown, never "the hub".
 */
import { describe, expect, it } from 'vitest'
import { formatTrackPlacement, trackPlacementRows } from '../track-placement-rows.js'

const HUB_NPU = { nodeId: 'hub', deviceKey: 'openvino:npu', modelId: 'yolo26n' }
const AGENT_CORAL = { nodeId: 'agent-b', deviceKey: 'edgetpu:pci', modelId: 'yolov8n-tflite' }

describe('formatTrackPlacement', () => {
  it('node · device (model)', () => {
    expect(formatTrackPlacement(HUB_NPU)).toBe('hub · openvino:npu (yolo26n)')
  })

  it('omits what the placement does not name', () => {
    expect(formatTrackPlacement({ nodeId: 'hub' })).toBe('hub')
    expect(formatTrackPlacement({ nodeId: 'hub', modelId: 'm' })).toBe('hub (m)')
    expect(formatTrackPlacement({ nodeId: 'hub', deviceKey: 'cpu' })).toBe('hub · cpu')
  })
})

describe('trackPlacementRows', () => {
  it('one row when the track never moved', () => {
    expect(
      trackPlacementRows({ openedPlacement: HUB_NPU, closedPlacement: { ...HUB_NPU } }),
    ).toEqual([{ kind: 'detected', value: 'hub · openvino:npu (yolo26n)' }])
  })

  it('two rows on a hop — opened, then closed', () => {
    expect(trackPlacementRows({ openedPlacement: HUB_NPU, closedPlacement: AGENT_CORAL })).toEqual([
      { kind: 'opened', value: 'hub · openvino:npu (yolo26n)' },
      { kind: 'closed', value: 'agent-b · edgetpu:pci (yolov8n-tflite)' },
    ])
  })

  it('nothing when the track names no placement', () => {
    expect(trackPlacementRows({})).toEqual([])
    expect(trackPlacementRows(undefined)).toEqual([])
  })

  it('a lone placement keeps its own label', () => {
    expect(trackPlacementRows({ closedPlacement: AGENT_CORAL })).toEqual([
      { kind: 'closed', value: 'agent-b · edgetpu:pci (yolov8n-tflite)' },
    ])
  })
})
