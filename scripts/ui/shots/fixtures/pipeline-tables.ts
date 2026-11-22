/**
 * The Pipeline page's tables on a phone (`/system/pipeline`):
 *  - Load balancing → the "Live load" per-agent table, fed by `pipeline.camera-metrics-snapshot`
 *    events (replayed by the harness);
 *  - a node's Engines tab (`?view=nodes&node=hub&ntab=engines`);
 *  - Auto tune (`?ctab=auto-tune`, click "Compute plan") with a plan covering both nodes.
 * Layered over `pipeline-cluster` (`--fixtures pipeline-cluster,pipeline-tables`). Invented data.
 */
import { defineFixtures } from './_define'

const NOW = (): number => Date.now()

function snapshot(deviceId: number, nodeId: string, fps: number, ms: number) {
  return {
    deviceId,
    nodeId,
    timestamp: NOW(),
    metrics: {
      phase: 'active',
      actualFps: fps,
      configuredFps: 10,
      avgInferenceTimeMs: ms,
      queueDepth: 1,
    },
  }
}

const HUB_ENGINES = [
  {
    engineKey: 'python:openvino:npu',
    engine: { runtime: 'python', backend: 'openvino', format: 'openvino', device: 'NPU' },
    modelsLoaded: ['yolov9-t', 'face-detect-s'],
    inUseByCameras: [101, 102, 103],
    kind: 'device-pool',
    poolPid: 4120,
    idleMs: null,
    idleTtlMs: null,
  },
  {
    engineKey: 'python:onnx:cpu',
    engine: { runtime: 'python', backend: 'onnxruntime', format: 'onnx' },
    modelsLoaded: ['plate-reader-s'],
    inUseByCameras: [102],
    kind: 'runtime',
    poolPid: null,
    idleMs: 42_000,
    idleTtlMs: 300_000,
  },
]

const CHOSEN = {
  modelId: 'yolov9-t',
  p50Ms: 14,
  fps: 71,
  measured: true,
  source: { kind: 'table' },
  capacitySessions: 6,
  personRecall: 0.81,
}

const PLAN = {
  planHash: 'plan-0001',
  family: 'yolov9',
  headroom: 0.4,
  minSessionsPerDevice: 2,
  cameraFps: 10,
  generatedAt: Date.UTC(2026, 10, 22, 9, 0, 0),
  nodes: [
    {
      nodeId: 'hub',
      reachable: true,
      hardwareClass: 'intel-core-ultra',
      cpuModel: 'Example Core Ultra 7',
      skipped: false,
      acceleratorModelId: 'yolov9-t',
      reasons: [],
      devices: [
        {
          deviceKey: 'openvino:NPU',
          accelerator: 'intel-npu',
          enabled: true,
          available: true,
          chosen: CHOSEN,
          reasons: [{ kind: 'capacity', sessions: 6, minSessions: 2 }],
        },
        {
          deviceKey: 'openvino:GPU',
          accelerator: 'intel-igpu',
          enabled: true,
          available: true,
          chosen: { ...CHOSEN, modelId: 'yolov9-s', p50Ms: 22, fps: 45, capacitySessions: 4 },
          reasons: [{ kind: 'tie-faster', over: 'yolov9-m', recallDelta: 0.01 }],
        },
        {
          deviceKey: 'onnx:cpu',
          accelerator: 'x86-cpu',
          enabled: true,
          available: true,
          chosen: null,
          reasons: [{ kind: 'cpu-device' }],
        },
      ],
    },
    {
      nodeId: 'garage-nuc',
      reachable: true,
      hardwareClass: 'intel-n-series',
      cpuModel: 'Example N100',
      skipped: false,
      acceleratorModelId: 'yolov9-t',
      reasons: [],
      devices: [
        {
          deviceKey: 'openvino:GPU',
          accelerator: 'intel-igpu',
          enabled: true,
          available: true,
          chosen: { ...CHOSEN, capacitySessions: 3 },
          reasons: [{ kind: 'capacity', sessions: 3, minSessions: 2 }],
        },
      ],
    },
  ],
  nodeChanges: [
    {
      nodeId: 'hub',
      deviceKey: 'openvino:NPU',
      madeExplicit: false,
      modelPins: [{ stepId: 'object-detection', before: 'yolov9-s', after: 'yolov9-t' }],
      thresholds: [],
    },
  ],
  warnings: [],
}

export default defineFixtures({
  area: 'pipeline-tables',
  description: 'Live load rows, a node engine inventory and an auto-tune plan, for the phone shots',
  handlers: {
    'event:pipeline.camera-metrics-snapshot': () => [
      snapshot(101, 'hub', 9.8, 14),
      snapshot(102, 'hub', 9.9, 15),
      snapshot(201, 'garage-nuc', 9.6, 31),
    ],
    'pipelineOrchestrator.getAudioNodeLoad': [
      { nodeId: 'hub', deviceCount: 2 },
      { nodeId: 'garage-nuc', deviceCount: 1 },
    ],
    'pipelineExecutor.listLoadedEngines': HUB_ENGINES,
    'pipelineRunner.getLocalCameras': [101, 102, 103],
    'pipelineOrchestrator.planAutoTune': PLAN,
  },
})
