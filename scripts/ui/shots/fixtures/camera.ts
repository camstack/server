/**
 * A camera's device page (`/devices/101`): header, function switches, the
 * Overview / Config / Customize / Detection pipeline / Bindings tabs and the
 * tabs the pipeline addons add (Recording, Analytics, Stream Broker, Snapshot).
 *
 * Invented cameras: 101 "Driveway" (mains), 102 "Garden" (battery) and 103
 * "Front door" (a doorbell customization — see the customize fixture).
 * The pipeline sections come from the REAL schema builders through
 * `_camera-aggregate.generated.json` (regenerate with `_gen-camera-aggregate.ts`).
 */
import { CAMERA_SWITCH_CATALOG, CAMERA_SWITCH_ORDER } from '@camstack/types'
import generated from './_camera-aggregate.generated.json'
import {
  ANALYTICS_WIDGETS,
  AUDIO_HISTORY,
  LIVE_STATS_SECTION,
  MOTION_EVENTS,
  OBJECT_EVENTS,
  OCCUPANCY_LTS,
} from './_camera-analytics'
import { defineFixtures } from './_define'
import { iso, NOW } from './_time'

interface Section {
  readonly id: string
  readonly fields: readonly Record<string, unknown>[]
  readonly [key: string]: unknown
}

function isSection(value: unknown): value is Section {
  if (typeof value !== 'object' || value === null) return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'fields' in value &&
    Array.isArray(value.fields)
  )
}

/** The generated JSON is opaque to the compiler: read it through a guard, never a cast. */
function readSections(value: unknown): readonly Section[] {
  if (!Array.isArray(value) || !value.every(isSection)) {
    throw new Error('_camera-aggregate.generated.json is out of date: run _gen-camera-aggregate.ts')
  }
  return value
}

const orchestratorSections = readSections(generated.orchestrator)
const analyticsSections = readSections(generated.analytics)
const nativeSections = [
  ...readSections(generated.native),
  ...readSections(generated.motionWasm),
  ...readSections(generated.snapshot),
  ...readSections(generated.reolinkMotion),
]
const batterySections = readSections(generated.reolinkBattery)

const camera = (id: number, name: string, battery: boolean) => ({
  id,
  stableId: `cam-${id}`,
  addonId: 'provider-reolink',
  type: 'camera',
  name,
  location: 'Front of house',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [
    'rebootable',
    'native-snapshot',
    'two-way-audio',
    ...(battery ? ['battery-operated'] : []),
  ],
  isCamera: true,
  config: {
    host: id === 101 ? '192.0.2.31' : id === 103 ? '192.0.2.33' : '192.0.2.32',
    port: 9000,
    username: 'camstack',
  },
  secretConfigPaths: ['password'],
  metadata: {
    manufacturer: 'Reolink',
    model: battery ? 'Argus 4 Pro' : 'RLC-811A',
    firmware: 'v3.1.0',
  },
})

/** A dishwasher page for the running override dialog. Not a camera. */
const KITCHEN_DISHWASHER = {
  id: 501,
  stableId: 'dev-501',
  addonId: 'bosch-home-connect',
  type: 'dishwasher',
  name: 'Kitchen dishwasher',
  location: 'Kitchen',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: [] as string[],
  isCamera: false,
  config: {},
  secretConfigPaths: [] as string[],
  metadata: { manufacturer: 'Example', model: 'dishwasher-1' },
}

const DEVICES = {
  101: camera(101, 'Driveway', false),
  102: camera(102, 'Garden', true),
  // A camera whose ONE customization is a doorbell (the 103 shape).
  103: camera(103, 'Front door', false),
  801: {
    id: 801,
    stableId: 'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
    addonId: 'provider-homeassistant',
    type: 'sensor',
    name: 'Porch thermostat',
    location: 'Porch',
    disabled: false,
    parentDeviceId: null,
    role: 'temperature-sensor',
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: { manufacturer: 'Example', model: 'thermostat-1' },
  },
  4700: {
    id: 4700,
    stableId: 'composed-blk-new',
    addonId: 'composer',
    type: 'sensor',
    name: 'New sensor',
    location: '',
    disabled: false,
    parentDeviceId: null,
    role: 'temperature-sensor',
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  },
  4603: {
    id: 4603,
    stableId: 'composed-blk-porch',
    addonId: 'composer',
    type: 'sensor',
    name: 'Porch (composto)',
    location: 'Porch',
    disabled: false,
    parentDeviceId: null,
    role: 'temperature-sensor',
    online: true,
    probed: true,
    features: [],
    isCamera: false,
    config: {},
    secretConfigPaths: [],
    metadata: {},
  },
  501: KITCHEN_DISHWASHER,
}

const widgetSection = (
  id: string,
  title: string,
  tab: string,
  widgetId: string,
  capName: string,
  addonId: string,
) => ({
  id,
  title,
  tab,
  location: 'top-tab',
  columns: 1,
  order: 0,
  fields: [
    {
      type: 'widget',
      key: `_${id}`,
      label: title,
      widgetId,
      span: 1,
      source: 'settings',
      writerCapName: capName,
      writerAddonId: addonId,
    },
  ],
})

const entry = (
  capName: string,
  kind: 'native' | 'wrapped',
  providerAddonId: string,
  nativeAddonId = 'provider-reolink',
) => ({ capName, kind, providerAddonId, providerNodeId: 'hub', nativeAddonId })

const BINDINGS = [
  entry('device-ops', 'native', 'provider-reolink'),
  entry('stream-params', 'native', 'provider-reolink'),
  entry('image-settings', 'native', 'provider-reolink'),
  entry('day-night', 'native', 'provider-reolink'),
  entry('privacy-mask', 'native', 'provider-reolink'),
  entry('ptz', 'native', 'provider-reolink'),
  entry('recording-onboard', 'native', 'provider-reolink'),
  entry('motion-zones', 'native', 'provider-reolink'),
  entry('detection-pipeline', 'wrapped', 'pipeline-orchestrator'),
  entry('audio-analysis', 'wrapped', 'audio-analyzer'),
  entry('motion-detection', 'wrapped', 'motion-wasm'),
  entry('pipeline-analytics', 'wrapped', 'pipeline-analytics'),
  entry('recording', 'wrapped', 'recorder'),
  entry('snapshot', 'wrapped', 'snapshot'),
  entry('stream-broker', 'wrapped', 'stream-broker'),
]

const BINDABLE = BINDINGS.filter((b) => b.kind === 'wrapped').map((b) => ({
  capName: b.capName,
  wrappers: [b.providerAddonId],
}))

const switchesFor = (deviceId: number) => ({
  deviceId,
  fetchedAt: NOW,
  switches: CAMERA_SWITCH_ORDER.map((id) => {
    const d = CAMERA_SWITCH_CATALOG[id]
    return {
      id,
      label: d.label,
      costWhenOff: d.costWhenOff,
      available: true,
      enabled: true,
      authority: d.authority,
    }
  }),
})

const TABS = [
  { id: 'image', label: 'Image', icon: 'image', order: 5 },
  { id: 'motion', label: 'Motion', icon: 'activity', order: 10 },
  { id: 'snapshot', label: 'Snapshot', icon: 'camera', order: 15 },
  { id: 'streaming', label: 'Streaming', icon: 'video', order: 35 },
  { id: 'general', label: 'General', icon: 'settings', order: 0 },
]

const RECORDING_CONFIG = {
  enabled: true,
  profiles: ['high', 'low'],
  segmentSeconds: 10,
  bands: [
    {
      days: [1, 2, 3, 4, 5, 6, 0],
      start: '06:00',
      end: '22:00',
      mode: 'events',
      audio: 'on',
      triggers: { motion: true, objectClasses: ['person', 'vehicle'] },
      postBufferSec: 30,
    },
    {
      days: [1, 2, 3, 4, 5, 6, 0],
      start: '22:00',
      end: '06:00',
      mode: 'continuous',
      audio: 'muted',
    },
  ],
  retention: { maxAgeDays: 14, maxSizeGb: 200 },
}

const slot = (deviceId: number, profile: string, w: number, h: number, codec: string) => ({
  deviceId,
  profile,
  brokerId: `${deviceId}/${profile}`,
  sourceCamStreamId: `native:${profile === 'high' ? 'main' : 'sub'}`,
  status: 'streaming',
  resolution: { width: w, height: h },
  codec,
})

const aggregateFor = (deviceId: number) => ({
  settings: {
    tabs: TABS,
    sections: [
      ...orchestratorSections,
      ...analyticsSections,
      ...nativeSections,
      ...(deviceId === 102 ? batterySections : []),
      widgetSection(
        'recording-playback',
        'Recording',
        'recording',
        'host/recording-panel',
        'recording',
        'recorder',
      ),
      LIVE_STATS_SECTION,
    ],
  },
  live: { sections: [] },
  tabs: undefined,
  deviceId,
})

export default defineFixtures({
  area: 'camera',
  description: 'A camera device page: header, tabs and pipeline settings for two invented cameras',
  handlers: {
    'deviceManager.getDevice': (i: { deviceId: number }) => DEVICES[i.deviceId] ?? null,
    'deviceManager.getDeviceAggregate': (i: { deviceId: number }) => aggregateFor(i.deviceId),
    'deviceManager.getBindings': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      entries: BINDINGS.map((b) => ({ ...b })),
    }),
    'deviceManager.listBindableCapsForDeviceType': BINDABLE,
    'deviceManager.getChildren': [],
    'pipelineOrchestrator.getPipelineAssignment': {
      deviceId: 101,
      agentNodeId: 'hub',
      reason: 'balanced',
      pinned: false,
      assignedAt: iso(NOW),
    },
    'pipelineRunner.getCameraMetrics': null,
    'audioMetrics.getCurrentSnapshot': null,
    'auth.listLoginMethods': [],
    'integrations.list': [
      {
        id: 'integration-reolink',
        addonId: 'provider-reolink',
        name: 'Reolink',
        enabled: true,
        info: {},
        createdAt: NOW - 30 * 86_400_000,
        updatedAt: NOW - 86_400_000,
        processState: 'running',
      },
    ],
    'pipelineOrchestrator.getCameraStatus': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      switchedOff: [],
      cameraSensors: { state: 'not-configured' },
    }),
    'coreBlocks.getCustomization': { state: 'loaded', view: null },
    'coreBlocks.listComposableCaps': { caps: [] },
    'deviceExtension.listSlots': [],
    'deviceManager.getWireableFields': [],
    'capabilities.getCapability': {
      name: 'composer',
      mode: 'singleton',
      providers: ['composer'],
      activeProvider: 'composer',
      disabledProviders: [],
    },
    'recordingArchive.getDeviceConfig': RECORDING_CONFIG,
    'recordingArchive.getStatus': (i: { deviceId: number }) => ({
      deviceId: i.deviceId,
      enabled: true,
      activeMode: 'events',
      nodeId: 'hub',
      storageBytes: 48_300_000_000,
    }),
    'recording.getAvailability': {
      read: 'read',
      ranges: [
        { startMs: NOW - 6 * 3_600_000, endMs: NOW - 5.5 * 3_600_000 },
        { startMs: NOW - 2 * 3_600_000, endMs: NOW - 1.8 * 3_600_000 },
      ],
    },
    'streamBroker.listAllProfileSlots': [
      slot(101, 'high', 3840, 2160, 'h265'),
      slot(101, 'low', 640, 360, 'h264'),
      slot(102, 'high', 2560, 1440, 'h265'),
    ],
    'pipelineAnalytics.getEventDensity': [],
    'pipelineAnalytics.listRetrainCollections': [],
    'pipelineOrchestrator.getCameraSwitches': (i: { deviceId: number }) => switchesFor(i.deviceId),
    'pipelineOrchestrator.getCameraMetrics': null,
    'notificationRules.listDeviceMutes': { mutedDeviceIds: [] },
    'webrtcSession.listStreams': [],
    'turnProvider.getTurnServers': [],
    'networkQuality.getDeviceStats': null,
    'deviceState.getCapSlice': null,
    'zoneAnalytics.getCurrentSnapshotBatch': [],
    'addonWidgets.listWidgets': ANALYTICS_WIDGETS,
    'pipelineAnalytics.getMotionEvents': MOTION_EVENTS,
    'pipelineAnalytics.getObjectEvents': OBJECT_EVENTS,
    'audioMetrics.getHistory': AUDIO_HISTORY,
    'pipelineAnalytics.readLongTermSeries': OCCUPANCY_LTS,
  },
})
