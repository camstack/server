/**
 * Pipeline → Cluster (`/system/pipeline`): the Load balancing and Settings tabs.
 * Two nodes with no cameras assigned, equal hardware shares, and the
 * orchestrator's global settings carrying the `load` ("Load balancer") and
 * `failover` sections the two tabs draw.
 */
import { defineFixtures } from './_define'

const NODES = ['hub', 'garage-nuc']

interface FixtureDevice {
  readonly key: string
  readonly format: 'openvino' | 'tflite' | 'onnx'
  readonly available: boolean
  readonly presence: 'present' | 'absent'
  readonly enabled: boolean
  readonly exclusion: 'disabled' | 'unavailable' | null
  readonly sharePct: number
  readonly effectivePct: number
  readonly sessionsNow: number
}

/**
 * Per node: a present accelerator in use, a CPU fallback switched off, and on
 * the hub a Coral that MOVED to another node — absent, its settings kept (D919).
 */
const DEVICES: Readonly<Record<string, readonly FixtureDevice[]>> = {
  hub: [
    {
      key: 'cpu',
      format: 'onnx',
      available: true,
      presence: 'present',
      enabled: false,
      exclusion: 'disabled',
      sharePct: 0,
      effectivePct: 0,
      sessionsNow: 0,
    },
    {
      key: 'edgetpu:usb',
      format: 'tflite',
      available: false,
      presence: 'absent',
      enabled: true,
      exclusion: 'unavailable',
      sharePct: 0,
      effectivePct: 0,
      sessionsNow: 0,
    },
    {
      key: 'openvino:gpu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      exclusion: null,
      sharePct: 100,
      effectivePct: 100,
      sessionsNow: 3,
    },
  ],
  'garage-nuc': [
    {
      key: 'cpu',
      format: 'onnx',
      available: true,
      presence: 'present',
      enabled: false,
      exclusion: 'disabled',
      sharePct: 0,
      effectivePct: 0,
      sessionsNow: 0,
    },
    {
      key: 'openvino:gpu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      exclusion: null,
      sharePct: 38,
      effectivePct: 38,
      sessionsNow: 1,
    },
    {
      key: 'openvino:npu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      exclusion: null,
      sharePct: 62,
      effectivePct: 62,
      sessionsNow: 2,
    },
  ],
}

function devicesOf(nodeId: string): readonly FixtureDevice[] {
  return DEVICES[nodeId] ?? []
}

const LOAD_SECTION = {
  id: 'load',
  title: 'Load Balancer',
  tab: 'pipeline',
  fields: [
    {
      key: 'sessionPlacement',
      type: 'select',
      label: 'Session placement',
      description:
        'How a new detection session picks its node and device. Honour shares (default) = the share of PARALLEL sessions is held to the node and device shares. Least-loaded = the node with the fewest sessions per unit of weight.',
      options: [
        { value: 'share', label: 'Honour shares' },
        { value: 'least-loaded', label: 'Least-loaded' },
      ],
      default: 'share',
      value: 'share',
    },
    {
      key: 'fpsMinThreshold',
      type: 'slider',
      label: 'Min FPS Threshold',
      description:
        'Per-camera low-FPS load shedding. 0 = disabled (default) — a single slow camera is never detached.',
      min: 0,
      max: 10,
      step: 1,
      default: 0,
      value: 0,
      showValue: true,
      unit: 'fps',
    },
    {
      key: 'nodeStressMode',
      type: 'select',
      label: 'Node stress handling',
      description:
        'When a node is saturated, Failover moves one of its cameras to an idle node. One camera at a time, a cooldown per camera, never back to the node it just left, at most 4 moves an hour across the cluster. A camera is never paused. Observe only logs the verdict; Off does nothing.',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'observe', label: 'Observe (log only)' },
        { value: 'failover', label: 'Failover (relocate a camera)' },
      ],
      default: 'failover',
      value: 'failover',
    },
    {
      key: 'fpsLowWindowMs',
      type: 'slider',
      label: 'Low FPS Window',
      description: 'How long a camera must stay below the Min FPS Threshold before it is paused.',
      min: 5_000,
      max: 600_000,
      step: 5_000,
      default: 60_000,
      value: 60_000,
      showValue: true,
      unit: 's',
      displayScale: 1000,
    },
  ],
}

const FAILOVER_SECTION = {
  id: 'failover',
  title: 'Failover',
  tab: 'pipeline',
  fields: [
    {
      key: 'failoverGraceMs',
      type: 'slider',
      label: 'Failover grace',
      description: 'How long a disconnected node keeps its cameras before they move.',
      min: 5_000,
      max: 300_000,
      step: 5_000,
      default: 30_000,
      value: 30_000,
      showValue: true,
      unit: 's',
      displayScale: 1000,
    },
  ],
}

export default defineFixtures({
  area: 'pipeline-cluster',
  description: 'Pipeline → Cluster: Load balancing and Settings tabs, two idle nodes',
  handlers: {
    'pipelineOrchestrator.getAgentLoad': [],
    'pipelineOrchestrator.getCameraStatuses': [],
    'pipelineOrchestrator.listAgentSettings': NODES.map((nodeId) => ({
      nodeId,
      settings: { detect: true, decode: true, detectWeight: 1 },
    })),
    'pipelineOrchestrator.getNodeInferenceDevices': (input: { nodeId: string }) => ({
      nodeId: input.nodeId,
      reachable: true,
      devices: devicesOf(input.nodeId).map((d) => {
        const [backend, device] = d.key.includes(':') ? d.key.split(':') : ['cpu', 'cpu']
        return {
          key: d.key,
          backend,
          device,
          format: d.format,
          available: d.available,
          presence: d.presence,
          enabled: d.enabled,
          weight: 1,
          maxSessions: d.key === 'openvino:npu' ? 4 : null,
          defaultModelId: d.format === 'tflite' ? 'yolov9s-320-edgetpu' : 'yolov9m-320-int8',
          exclusion: d.exclusion,
        }
      }),
    }),
    'auth.listLoginMethods': [],
    'pipelineOrchestrator.getAudioAssignments': [],
    'pipelineOrchestrator.getAudioNodeLoad': [],
    'pipelineOrchestrator.getPipelineAssignments': [],
    'pipelineOrchestrator.getEffectiveShares': {
      source: 'hardware',
      policy: 'share',
      autoPending: false,
      computedAt: 1_760_000_000_000,
      trigger: null,
      nodes: NODES.map((nodeId) => ({
        nodeId,
        eligible: true,
        configuredPct: 50,
        effectivePct: 50,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: devicesOf(nodeId)
          .filter((d) => d.enabled && d.presence === 'present')
          .map((d) => ({
            deviceKey: d.key,
            eligible: d.exclusion === null,
            configuredPct: d.sharePct,
            effectivePct: d.effectivePct,
          })),
      })),
      nodeWeights: Object.fromEntries(NODES.map((n) => [n, 1])),
      deviceWeights: {},
    },
    'pipelineOrchestrator.getPlacementStats': {
      policy: 'share',
      windowMs: 3_600_000,
      observedForMs: 3_600_000,
      sessionsNow: 0,
      clusterPeakSessions: 0,
      nodes: NODES.map((nodeId) => ({
        nodeId,
        sessionsNow: 0,
        sessionsStarted: 0,
        observedShare: null,
        peakSessions: 0,
        yieldsAway: 0,
        devices: devicesOf(nodeId)
          .filter((d) => d.sessionsNow > 0)
          .map((d) => ({
            deviceKey: d.key,
            sessionsNow: d.sessionsNow,
            sessionsStarted: d.sessionsNow,
            observedShare: null,
          })),
      })),
      stalePins: [],
    },
    'addonSettings.getGlobalSettings': (input: { addonId?: string }) =>
      input.addonId === 'pipeline-orchestrator'
        ? { tabs: null, sections: [LOAD_SECTION, FAILOVER_SECTION] }
        : null,
    // Auto tune (D745): one node change and one kept custom pin. A model and its
    // thresholds live on the accelerator only (D927) — no camera rows.
    'pipelineOrchestrator.planAutoTune': {
      planHash: 'demo-plan',
      family: 'yolov9',
      headroom: 0.4,
      minSessionsPerDevice: 2,
      cameraFps: 10,
      generatedAt: 1_760_000_000_000,
      nodes: NODES.map((nodeId) => ({
        nodeId,
        reachable: true,
        hardwareClass: 'intel-n-series',
        cpuModel: 'Intel(R) N100',
        skipped: false,
        acceleratorModelId: 'yolov9s-320-int8',
        devices: [],
        reasons: [],
      })),
      nodeChanges: [
        {
          nodeId: 'hub',
          deviceKey: 'openvino:gpu',
          madeExplicit: false,
          modelPins: [{ stepId: 'object-detection', before: null, after: 'yolov9s-320-int8' }],
          thresholds: [{ stepId: 'object-detection', keys: ['minConfidencePerson'] }],
        },
      ],
      warnings: [
        {
          kind: 'custom-pin-kept',
          nodeId: 'garage-nuc',
          deviceKey: 'openvino:gpu',
          modelId: 'custom-yolov9m-640-ft',
        },
      ],
    },
    'system.info': { serverName: { name: 'Hub', isDefault: false } },
    'auth.getServerName': { name: 'Hub', isDefault: false },
  },
})
