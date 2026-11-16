/**
 * Archive (`/archive`, `/archive/:deviceId`): eight cameras with footage and event storage, three
 * storage locations (one draining), a health digest with two findings, a short activity log, and
 * one export. Invented data.
 */
import { defineFixtures } from './_define'
import { D, H, MINUTE, NOW } from './_time'

const GB = 1024 ** 3
const MB = 1024 ** 2

const camera = (id: number, name: string, location: string) => ({
  id,
  stableId: `dev-${id}`,
  addonId: 'provider-reolink',
  type: 'camera',
  name,
  location,
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [],
  isCamera: true,
  config: {},
  secretConfigPaths: [],
  metadata: {},
})

const CAMERAS = [
  camera(101, 'Front door', 'Entrance'),
  camera(102, 'Driveway', 'Garden'),
  camera(103, 'Backyard', 'Garden'),
  camera(104, 'Garage', 'Garage'),
  camera(105, 'Living room', 'Living room'),
  camera(106, 'Nursery', 'Bedroom'),
  camera(107, 'Side gate', 'Garden'),
  camera(108, 'Porch', 'Entrance'),
]

const FOOTAGE_GB = [412, 388, 301, 142, 96, 0, 254, 330]
const OLDEST_DAYS = [21, 21, 19, 14, 9, 0, 18, 21]
const EVENT_ROWS = [5120, 6841, 2310, 950, 410, 0, 1760, 4012]

const loc = (
  id: string,
  type: string,
  displayName: string,
  root: string,
  total: number,
  free: number,
  mode: string,
) => ({
  id,
  type,
  displayName,
  providerId: 'fs',
  config: { basePath: root },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode,
  capacity: { totalBytes: total * GB, availableBytes: free * GB },
})

const LOCATIONS = [
  loc(
    'recordings:ssd',
    'recordings',
    'Recordings (SSD)',
    '/media/recordings',
    3720,
    1240,
    'active',
  ),
  loc(
    'recordings:old',
    'recordings',
    'Recordings (old disk)',
    '/media/recordings-old',
    1860,
    410,
    'drain',
  ),
  loc('eventMedia:default', 'eventMedia', 'Event media', '/media/events', 930, 610, 'active'),
]

const status = (deviceId: number, mode: string, switchedOff: readonly string[] = []) => ({
  deviceId,
  assignment: null,
  source: null,
  broker: null,
  decoder: null,
  motion: null,
  detection: null,
  audio: null,
  recording: { mode, active: mode !== 'off', storageBytes: 0 },
  switchedOff,
  degraded: [],
})

const STATUSES = [
  status(101, 'continuous'),
  status(102, 'continuous'),
  status(103, 'events'),
  status(104, 'events'),
  status(105, 'events'),
  status(106, 'off', ['recording']),
  status(107, 'events'),
  status(108, 'continuous'),
]

const DIGEST = {
  latest: {
    generatedAt: NOW - 3 * MINUTE,
    tickMs: 42,
    camerasSeen: 8,
    findings: [
      {
        id: 'frames-shed:104',
        kind: 'frames-shed',
        severity: 'warning',
        subject: { type: 'camera', deviceId: 104 },
        what: 'Garage is shedding frames before detection',
        evidence: { shedPerMinute: 41 },
        action: 'Move its detection to a faster device or lower its frame rate.',
      },
      {
        id: 'motion-without-detections:107',
        kind: 'motion-without-detections',
        severity: 'info',
        subject: { type: 'camera', deviceId: 107 },
        what: 'Side gate sees motion but no detections',
        evidence: { motionEvents: 38 },
        action: 'Check the detection zones and the confidence floor.',
      },
    ],
    cameraSignals: [],
    nodes: [],
    sources: [],
    notCovered: [],
  },
  previous: [],
}

const OPS = [
  {
    id: 'o1',
    at: NOW - 40 * MINUTE,
    domain: 'recording',
    op: 'retention-run',
    reason: 'retention',
    deviceId: 101,
    nodeId: 'hub',
    itemsAffected: 24,
    bytesReclaimed: 9 * GB,
    detail: null,
    actor: 'system',
  },
  {
    id: 'o2',
    at: NOW - 5 * H,
    domain: 'recording',
    op: 'prune',
    reason: 'quota',
    deviceId: 102,
    nodeId: 'hub',
    itemsAffected: 12,
    bytesReclaimed: 4 * GB,
    detail: 'disk pressure',
    actor: 'system',
  },
  {
    id: 'o3',
    at: NOW - 1 * D,
    domain: 'events',
    op: 'manual-delete',
    reason: 'manual',
    deviceId: 105,
    nodeId: 'hub',
    itemsAffected: 310,
    bytesReclaimed: 180 * MB,
    detail: null,
    actor: 'admin',
  },
]

const EXPORT = {
  id: 'x1',
  deviceId: 101,
  profile: 'high',
  state: 'ready',
  createdAt: NOW - 3 * H,
  createdBy: 'admin',
  fromMs: NOW - 5 * H,
  toMs: NOW - 4 * H,
  options: {
    title: 'Parcel at the door',
    includeAudio: true,
    maxLifeMs: 7 * D,
    deleteAfterDownload: false,
  },
  progressPct: null,
  fileBytes: 182 * MB,
  expiresAt: NOW + 6 * D,
  deleteAfterDownload: false,
  downloadedAt: null,
  error: null,
}

export default defineFixtures({
  area: 'archive',
  description:
    'Archive overview and camera page: footage, event storage, health, activity, exports.',
  handlers: {
    'deviceManager.listAll': CAMERAS,
    // No urgent-alert toast over the page being shot.
    'alerts.getUnreadCount': 0,
    'alerts.list': [],
    'recordingArchive.getStorageUsage': {
      nodeId: 'hub',
      totalUsedBytes: FOOTAGE_GB.reduce((a, b) => a + b, 0) * GB,
      devicesRead: 'archive',
      complete: true,
      devices: CAMERAS.map((c, i) => ({
        deviceId: c.id,
        usedBytes: (FOOTAGE_GB[i] ?? 0) * GB,
        oldestMs: (OLDEST_DAYS[i] ?? 0) === 0 ? null : NOW - (OLDEST_DAYS[i] ?? 0) * D,
        segments: (FOOTAGE_GB[i] ?? 0) * 40,
      })),
      locations: [
        {
          locationId: 'recordings:ssd',
          root: '/media/recordings',
          usedBytes: 1500 * GB,
          availableBytes: 1240 * GB,
          totalBytes: 3720 * GB,
        },
        {
          locationId: 'recordings:old',
          root: '/media/recordings-old',
          usedBytes: 460 * GB,
          availableBytes: 410 * GB,
          totalBytes: 1860 * GB,
        },
      ],
    },
    'pipelineAnalytics.getEventStoreFootprint': {
      totalRows: EVENT_ROWS.reduce((a, b) => a + b, 0),
      totalBytes: 96 * GB,
      devices: CAMERAS.map((c, i) => ({
        deviceId: c.id,
        rows: EVENT_ROWS[i] ?? 0,
        bytes: (EVENT_ROWS[i] ?? 0) * 6 * MB,
      })),
    },
    'pipelineOrchestrator.getCameraStatuses': STATUSES,
    'pipelineOrchestrator.getHealthDigest': DIGEST,
    'storage.listLocations': LOCATIONS,
    'storage.listLocationDeclarations': [],
    'storage.listDrainProgress': [],
    'recordingArchive.listOpsLog': OPS.filter((o) => o.domain === 'recording'),
    'pipelineAnalytics.listOpsLog': OPS.filter((o) => o.domain === 'events'),
    'recording.listSources': [
      {
        source: 'camstack',
        label: 'CamStack recordings',
        addonId: 'recorder',
        availability: { state: 'ok' },
      },
    ],
    'recording.getAvailability': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      read: 'read',
      ranges: [
        { profile: 'high', startMs: NOW - 30 * H, endMs: NOW - 22 * H },
        { profile: 'high', startMs: NOW - 20 * H, endMs: NOW - 9 * H },
        { profile: 'high', startMs: NOW - 8 * H, endMs: NOW - 5 * MINUTE },
      ],
      profilesWithFootage: ['high'],
    }),
    'recording.getDaysWithRecordings': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      read: 'read',
      days: [NOW - 2 * D, NOW - 1 * D, NOW].map((t) => t - (t % D)),
    }),
    'recordingExport.listExports': [EXPORT],
    'recordingExport.listJobs': [EXPORT],
  },
})
