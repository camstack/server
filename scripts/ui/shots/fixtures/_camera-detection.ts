/**
 * The camera "Detection pipeline" tab: the steps tree (Steps) and the
 * contributed settings (Settings).
 *
 * Three cameras, one per root-detector source: 107 runs the pipeline's own
 * root step, 593 uses the camera's onboard detector alone, 594 has no root
 * detector at all. the `camera-detection-legacy` area additionally serves the pre-move shape —
 * the `detectionSources` picker as a contributed Settings section — so the
 * "before" run shows what the page looked like.
 *
 * Invented data only.
 */
const CAMERAS = {
  592: { name: 'Front door', sources: ['pipeline'] as string[], geometry: 'boxed' },
  593: { name: 'Garden', sources: ['onboard'] as string[], geometry: 'boxed' },
  594: { name: 'Garage', sources: [] as string[], geometry: 'boxed' },
} as const

type CameraId = keyof typeof CAMERAS
const camera = (input: { deviceId: number }) => CAMERAS[input.deviceId as CameraId] ?? CAMERAS[107]

const device = (input: { deviceId: number }) => ({
  id: input.deviceId,
  stableId: `mac-0000000000${String(input.deviceId)}`,
  addonId: 'provider-reolink',
  type: 'camera',
  name: camera(input).name,
  location: 'Home',
  disabled: false,
  parentDeviceId: null,
  role: null,
  online: true,
  probed: true,
  features: ['native-snapshot'],
  isCamera: true,
  config: {},
  secretConfigPaths: [],
  metadata: {},
  integrationId: null,
})

const model = (id: string, name: string) => ({
  id,
  name,
  formats: { openvino: { downloaded: true, sizeMB: 9, onDisk: 'current' } },
  group: { family: 'yolo', tier: 'n', resolution: 640 },
  provider: 'camstack',
  defaultConfidence: 0.5,
})

const addon = (
  id: string,
  name: string,
  slot: string,
  inputClasses: string[],
  outputClasses: string[],
  childSlots: string[],
) => ({
  id,
  name,
  slot,
  inputClasses,
  outputClasses,
  childSlots,
  models: [model(`${id}-n`, `${name} nano`)],
  defaultModelId: `${id}-n`,
  defaultConfidence: 0.5,
  configSchema: [
    {
      type: 'slider',
      key: 'minConfidence',
      label: 'Minimum confidence',
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.5,
      showValue: true,
    },
  ],
})

const SCHEMA = {
  availableEngines: [
    {
      engine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
      devices: [{ id: 'gpu', label: 'GPU' }],
      defaultDevice: 'gpu',
    },
  ],
  selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'gpu' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        addon(
          'object-detection',
          'Object Detection',
          'detector',
          [],
          ['person', 'vehicle', 'animal'],
          ['cropper', 'classifier'],
        ),
      ],
    },
    {
      id: 'cropper',
      label: 'Cropper',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        addon('face-detection', 'Face Detection', 'cropper', ['person'], ['face'], ['classifier']),
        addon(
          'plate-detection',
          'Plate Detection',
          'cropper',
          ['vehicle'],
          ['plate'],
          ['classifier'],
        ),
      ],
    },
    {
      id: 'classifier',
      label: 'Classifier',
      priority: 2,
      parentSlot: 'cropper',
      addons: [
        addon('face-embedding', 'Face Recognition', 'classifier', ['face'], ['identity'], []),
        addon('plate-ocr', 'Plate Reader', 'classifier', ['plate'], ['plate-text'], []),
        addon(
          'animal-classifier',
          'Animal Classifier',
          'classifier',
          ['animal'],
          ['animal-type'],
          [],
        ),
      ],
    },
  ],
}

const DEVICES = {
  nodeId: 'hub',
  reachable: true,
  devices: [
    {
      key: 'openvino:gpu',
      backend: 'openvino',
      device: 'gpu',
      format: 'openvino',
      available: true,
      enabled: true,
      weight: 50,
      maxSessions: null,
      defaultModelId: 'object-detection-n',
      exclusion: null,
    },
  ],
}

const sourceField = (value: readonly string[], key: string) => ({
  type: 'multiselect',
  key,
  label: key === 'detectionSources' ? 'Root detector' : 'Detection Sources',
  description: "Which detector produces this camera's first-level detections.",
  options: [
    { value: 'pipeline', label: 'This node (ML root step on decoded frames)' },
    { value: 'onboard', label: 'Camera onboard AI' },
  ],
  default: ['pipeline'],
  value,
  writerCapName: 'camera-pipeline-config',
  writerAddonId: 'pipeline-orchestrator',
  source: 'settings',
})

const aggregate = (legacy: boolean) => (input: { deviceId: number }) => ({
  settings: {
    sections: [
      {
        id: 'pipeline-object-detection',
        title: 'Object detection',
        tab: 'detection-pipeline',
        location: 'top-tab',
        order: 1,
        fields: [
          {
            type: 'slider',
            key: 'detectionFps',
            label: 'Detection FPS',
            min: 1,
            max: 30,
            step: 1,
            default: 10,
            value: 10,
            showValue: true,
            unit: 'fps',
            writerCapName: 'camera-pipeline-config',
            writerAddonId: 'pipeline-orchestrator',
            source: 'settings',
          },
        ],
      },
      {
        id: 'motion-tuning',
        title: 'Motion',
        tab: 'detection-pipeline',
        location: 'top-tab',
        order: 4,
        fields: [
          {
            type: 'slider',
            key: 'motionFps',
            label: 'Motion FPS (analyzer)',
            min: 1,
            max: 15,
            step: 1,
            default: 5,
            value: 5,
            showValue: true,
            unit: 'fps',
            writerCapName: 'camera-pipeline-config',
            writerAddonId: 'pipeline-orchestrator',
            source: 'settings',
          },
          ...(legacy ? [sourceField(camera(input).sources, 'detectionSources')] : []),
        ],
      },
      ...(legacy
        ? [
            {
              id: 'detection-sources',
              title: 'Detection sources',
              tab: 'detection-pipeline',
              location: 'top-tab',
              order: 8,
              fields: [sourceField(camera(input).sources, 'detectionSources')],
            },
          ]
        : []),
      {
        id: 'zones',
        title: 'Detection Zones',
        tab: 'zones',
        location: 'top-tab',
        columns: 1,
        order: 0,
        fields: [
          {
            type: 'widget',
            key: 'zones',
            label: 'Detection Zones',
            widgetId: 'pipeline-orchestrator/zone-editor',
            span: 1,
            source: 'settings',
            writerCapName: 'zones',
            writerAddonId: 'pipeline-orchestrator',
          },
        ],
      },
    ],
  },
  live: { sections: [] },
})

export const cameraDetectionHandlers = (legacy: boolean): Readonly<Record<string, unknown>> => ({
  'audioMetrics.getCurrentSnapshot': null,
  'auth.listLoginMethods': [],
  'deviceManager.getBindings': (input: { deviceId: number }) => ({
    deviceId: input.deviceId,
    entries: [
      {
        capName: 'native-object-detection',
        kind: 'native',
        providerAddonId: 'provider-reolink',
        providerNodeId: 'hub',
        nativeAddonId: 'provider-reolink',
      },
      {
        capName: 'camera-pipeline-config',
        kind: 'wrapped',
        providerAddonId: 'pipeline-orchestrator',
        providerNodeId: 'hub',
        nativeAddonId: '',
      },
    ],
  }),
  'deviceManager.getChildren': [],
  'deviceManager.getDevice': device,
  'deviceManager.getDeviceAggregate': aggregate(legacy),
  'pipelineOrchestrator.getPipelineAssignment': {
    deviceId: 107,
    agentNodeId: 'hub',
    pinned: false,
    reason: 'capacity',
    assignedAt: 1_760_000_000_000,
  },
  'pipelineRunner.getCameraMetrics': null,
  'pipelineOrchestrator.getCameraMetrics': null,
  'pipelineOrchestrator.getCameraSwitches': [],
  'addonWidgets.listWidgets': [
    {
      tab: 'device-tab',
      label: 'Zone Editor',
      kind: 'remote',
      remote: {
        remoteName: 'addon_pipeline_orchestrator_widgets',
        exposedModule: './widgets',
        componentKey: 'zone-editor',
      },
      preAuth: false,
      stableId: 'zone-editor',
      description: 'Polygon / tripwire CRUD + per-stage rule editor.',
      icon: 'shapes',
      bundle: 'remoteEntry.js',
      hosts: ['device-tab'],
      requires: { deviceContext: true, integrationContext: false },
      defaultSize: 'xl',
      allowedSizes: ['lg', 'xl'],
      defaultColumns: 12,
      defaultRows: 4,
      addonId: 'pipeline-orchestrator',
      bundleUrl: '/api/addon-widgets/pipeline-orchestrator/remoteEntry.js',
    },
  ],
  'deviceState.getCapSlice': (input: { capName: string }) => {
    if (input.capName === 'zones') {
      return {
        zones: [
          {
            id: 'uscio',
            name: 'Uscio',
            kind: 'polygon',
            polygon: [
              { x: 0.13, y: 0.36 },
              { x: 0.75, y: 0.36 },
              { x: 0.75, y: 1 },
              { x: 0.13, y: 1 },
            ],
            color: '#3b82f6',
          },
        ],
      }
    }
    if (input.capName === 'zone-rules') {
      return {
        motion: [],
        detection: [],
        package: [
          {
            id: 'pacchetti',
            name: 'Pacchetti',
            zoneIds: ['uscio'],
            mode: 'include',
            enabled: true,
          },
        ],
      }
    }
    return null
  },
  'turnProvider.getTurnServers': [],
  'webrtcSession.listStreams': [],
  'zoneAnalytics.getCurrentSnapshotBatch': {},
  'pipelineOrchestrator.getCameraSettings': null,
  'pipelineOrchestrator.listAgentSettings': [
    {
      nodeId: 'hub',
      settings: {
        maxCameras: null,
        detectWeight: 15,
        detect: true,
        decode: true,
        audio: true,
        ingest: true,
        reachableHost: '192.0.2.2',
        color: 'node-a',
        inferenceDevices: { 'openvino:gpu': { enabled: true, weight: 50 } },
      },
    },
  ],
  'pipelineOrchestrator.getNodeInferenceDevices': DEVICES,
  'pipelineExecutor.getSchema': SCHEMA,
  'pipelineOrchestrator.getCameraDetectionSource': (input: { deviceId: number }) => {
    const sources = camera(input).sources
    return {
      source: sources[0] ?? 'none',
      explicit: true,
      onboard: { available: true, geometry: camera(input).geometry },
    }
  },
  'mut:pipelineOrchestrator.setCameraDetectionSource': { success: true },
})
