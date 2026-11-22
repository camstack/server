/**
 * Tables that no admin route mounts, shot through `/phone-tables-preview`: the node live tab's
 * per-camera rows and one camera's historical tracks (click a track row to open its position
 * table). Invented data.
 */
import { defineFixtures } from './_define'
import cameraArea from './camera'

const NOW = Date.UTC(2026, 10, 22, 9, 0, 0)

function positions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    x: 0.12 + i * 0.07,
    y: 0.4 + i * 0.03,
    timestamp: NOW - 60_000 + i * 1_000,
    bbox: { x: 0.1, y: 0.1, w: 0.1, h: 0.2 },
  }))
}

function track(trackId: string, className: string, offsetMs: number) {
  return {
    trackId,
    deviceId: 101,
    className,
    state: 'ended',
    firstSeen: NOW - offsetMs - 60_000,
    lastSeen: NOW - offsetMs,
    positions: positions(6),
    snapshots: [],
    zonesVisited: ['Driveway', 'Porch'],
    totalDistance: 0.42,
  }
}

const TAPE_STATUS = {
  cameras: [
    {
      deviceId: 101,
      state: 'recording',
      gapsSinceArmed: 0,
      segmentsHeld: 12,
      bytesLastHour: 48_000_000,
      bytesHeld: 190_000_000,
      framesPerMin: 120,
    },
    {
      deviceId: 102,
      state: 'off',
      gapsSinceArmed: 0,
      segmentsHeld: 0,
      bytesLastHour: 0,
      bytesHeld: 0,
    },
    {
      deviceId: 103,
      state: 'failing',
      reason: 'disk full',
      gapsSinceArmed: 3,
      segmentsHeld: 4,
      bytesLastHour: 2_000_000,
      bytesHeld: 40_000_000,
      framesPerMin: 30,
    },
  ],
}

const TAPE_LIST = {
  tapes: [
    {
      id: 'tape-1',
      deviceId: 101,
      scenario: 'courier-at-the-gate',
      note: null,
      lighting: 'day',
      fromMs: NOW - 3_600_000,
      toMs: NOW - 3_500_000,
      state: 'complete',
      frames: 480,
      gaps: 0,
      bytes: 31_000_000,
      reviewed: true,
      released: false,
      tracks: ['t-1001', 't-1002'],
      tracksStillStored: 2,
    },
    {
      id: 'tape-2',
      deviceId: 103,
      scenario: 'night-visitor',
      note: null,
      lighting: 'ir',
      fromMs: NOW - 7_200_000,
      toMs: NOW - 7_100_000,
      state: 'incomplete',
      frames: 320,
      gaps: 2,
      bytes: 22_000_000,
      reviewed: false,
      released: true,
      tracks: ['t-2001'],
      tracksStillStored: 0,
    },
  ],
}

export default defineFixtures({
  area: 'phone-tables',
  description: 'Node live metrics and a camera track list for the unmounted-table preview',
  handlers: {
    'deviceManager.listAll': [
      { id: 101, name: 'Driveway', type: 'camera' },
      { id: 102, name: 'Back garden', type: 'camera' },
      { id: 103, name: 'Side passage', type: 'camera' },
    ],
    'mut:addons.custom': (input: { action?: string }) =>
      input.action === 'debug.tape.status'
        ? TAPE_STATUS
        : input.action === 'debug.tape.list'
          ? TAPE_LIST
          : null,
    'deviceManager.getBindings': cameraArea.handlers['deviceManager.getBindings'],
    'pipelineRunner.getLocalMetrics': {
      nodeId: 'hub',
      activeCameras: 3,
      throttledCameras: 1,
      avgInferenceTimeMs: 18,
      queueDepth: 2,
    },
    'pipelineRunner.getAllCameraMetrics': [
      { deviceId: 101, phase: 'active', actualFps: 9.8, queueDepth: 1, avgInferenceTimeMs: 14 },
      { deviceId: 102, phase: 'idle', actualFps: 1.0, queueDepth: 0, avgInferenceTimeMs: 15 },
      { deviceId: 103, phase: 'active', actualFps: 9.6, queueDepth: 1, avgInferenceTimeMs: 31 },
    ],
    'pipelineAnalytics.getActiveTracks': [],
    'pipelineAnalytics.listTracks': [
      track('t-1001', 'person', 120_000),
      track('t-1002', 'vehicle', 600_000),
    ],
  },
})
