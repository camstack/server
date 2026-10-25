/**
 * Library → Events → Feed (`/library?tab=events&section=feed`) and the track
 * detail panel it opens: one key event per camera, and a track that was BORN
 * on the hub's NPU and last seen on an agent's Coral (a session that hopped
 * node mid-track, D916) — so the detail shows both placements.
 * Open the panel with `--step "js:document.querySelector('.aspect-video img').click()"`.
 */
import { defineFixtures } from './_define'
import { MINUTE, NOW } from './_time'

interface KeyEventsInput {
  readonly deviceIds?: readonly number[]
}

const CAMERA_IDS = [301, 302] as const
const TRACK_FIRST_SEEN = NOW - 12 * MINUTE
const TRACK_LAST_SEEN = TRACK_FIRST_SEEN + 47_000

function keyEventsFor(input: KeyEventsInput): readonly unknown[] {
  return (input.deviceIds ?? []).map((deviceId, i) => ({
    deviceId,
    events: [
      {
        id: `ev-${String(deviceId)}`,
        trackId: `trk-${String(deviceId)}-a1`,
        timestamp: TRACK_FIRST_SEEN - i * MINUTE,
        className: 'person',
        importance: 0.72,
        bestEventId: String(9000 + deviceId),
      },
    ],
  }))
}

function trackFor(input: { readonly deviceId?: number; readonly trackId?: string }): unknown {
  return {
    trackId: input.trackId ?? 'trk-unknown',
    deviceId: input.deviceId ?? 0,
    className: 'person',
    firstSeen: TRACK_FIRST_SEEN,
    lastSeen: TRACK_LAST_SEEN,
    positions: [],
    snapshots: [],
    zonesVisited: ['Driveway'],
    totalDistance: 412.5,
    state: 'moving',
    active: false,
    importance: 0.72,
    importanceReason: 'entered Driveway',
    bestEventId: String(9000 + (input.deviceId ?? 0)),
    modelId: 'yolo26n',
    openedPlacement: { nodeId: 'hub', deviceKey: 'openvino:npu', modelId: 'yolo26n' },
    closedPlacement: {
      nodeId: 'agent-b',
      deviceKey: 'edgetpu:pci',
      modelId: 'yolov8n-tflite',
    },
  }
}

export default defineFixtures({
  area: 'events',
  description:
    'Library → Events feed: one key event per camera; the track detail shows a node/device hop.',
  handlers: {
    'deviceManager.listAll': CAMERA_IDS.map((id, i) => ({
      id,
      name: `Camera ${'AB'[i] ?? 'X'}`,
      stableId: `demo-camera-${String(id)}`,
      addonId: 'demo-provider',
      disabled: false,
      type: 'camera',
      location: null,
      isCamera: true,
    })),
    'pipelineAnalytics.getKeyEventsBatch': (input: KeyEventsInput) => keyEventsFor(input),
    'pipelineAnalytics.listEventKindsBatch': [],
    'pipelineAnalytics.getTrack': trackFor,
    'pipelineAnalytics.listTrackMedia': [],
    'pipelineAnalytics.listEventMedia': [],
  },
})
