/**
 * Demo answers for the public README shots. Neutral names only
 * (Front door, Driveway, agent-a, agent-b). Loaded first so it
 * overrides the shell's urgent-alert toast and the idle pipeline fixture.
 */
import { defineFixtures } from './_define'
import { iso, NOW } from './_time'

const NODES = ['hub', 'agent-a', 'agent-b'] as const

function integration(id: string, addonId: string, name: string) {
  return {
    id,
    addonId,
    name,
    enabled: true,
    info: {},
    createdAt: NOW,
    updatedAt: NOW,
    processState: 'running' as const,
  }
}

function frontDoor(deviceId: number) {
  return {
    id: deviceId,
    stableId: 'cam-101',
    addonId: 'provider-reolink',
    type: 'camera',
    name: 'Front door',
    location: 'Front of house',
    disabled: false,
    parentDeviceId: null,
    role: null,
    online: true,
    probed: true,
    features: ['native-snapshot'],
    isCamera: true,
    config: {},
    secretConfigPaths: [],
    metadata: { manufacturer: 'Example', model: 'DemoCam' },
  }
}

interface Accel {
  readonly key: string
  readonly format: 'openvino' | 'onnx'
  readonly available: boolean
  readonly presence: 'present' | 'absent'
  readonly enabled: boolean
  readonly exclusion: 'disabled' | 'unavailable' | null
  readonly sharePct: number
  readonly sessionsNow: number
}

const DEVICES: Readonly<Record<string, readonly Accel[]>> = {
  hub: [
    {
      key: 'cpu',
      format: 'onnx',
      available: true,
      presence: 'present',
      enabled: false,
      exclusion: 'disabled',
      sharePct: 0,
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
      sessionsNow: 4,
    },
  ],
  'agent-a': [
    {
      key: 'cpu',
      format: 'onnx',
      available: true,
      presence: 'present',
      enabled: false,
      exclusion: 'disabled',
      sharePct: 0,
      sessionsNow: 0,
    },
    {
      key: 'openvino:npu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      exclusion: null,
      sharePct: 100,
      sessionsNow: 3,
    },
  ],
  'agent-b': [
    {
      key: 'openvino:gpu',
      format: 'openvino',
      available: true,
      presence: 'present',
      enabled: true,
      exclusion: null,
      sharePct: 100,
      sessionsNow: 2,
    },
  ],
}

const ATTACHED: Readonly<Record<string, number>> = {
  hub: 4,
  'agent-a': 3,
  'agent-b': 2,
}

const SHARE: Readonly<Record<string, number>> = {
  hub: 46,
  'agent-a': 32,
  'agent-b': 22,
}

function devicesOf(nodeId: string): readonly Accel[] {
  return DEVICES[nodeId] ?? []
}

function loadOf(nodeId: string): {
  nodeId: string
  online: boolean
  score: number
  decodeHwaccel: string
  load: {
    nodeId: string
    attachedCameras: number
    activeCameras: number
    avgInferenceFps: number
    avgInferenceTimeMs: number
    queueDepthTotal: number
    devices: { deviceKey: string; backend: string; attachedCameras: number }[]
    hardware: { hasGpu: boolean; inferenceBackend: string; cpuCores: number }
  }
} {
  const attached = ATTACHED[nodeId] ?? 0
  const active = devicesOf(nodeId)
    .filter((d) => d.enabled && d.exclusion === null)
    .map((d) => ({
      deviceKey: d.key,
      backend: d.key.includes(':') ? (d.key.split(':')[0] ?? 'cpu') : 'cpu',
      attachedCameras: d.sessionsNow,
    }))
  return {
    nodeId,
    online: true,
    score: attached,
    decodeHwaccel: nodeId === 'agent-a' ? 'qsv' : 'vaapi',
    load: {
      nodeId,
      attachedCameras: attached,
      activeCameras: attached,
      avgInferenceFps: 8.4,
      avgInferenceTimeMs: nodeId === 'hub' ? 18 : 24,
      queueDepthTotal: 0,
      devices: active,
      hardware: { hasGpu: true, inferenceBackend: 'openvino', cpuCores: 8 },
    },
  }
}

const CAMERAS = [
  [1, 'Front door', 'Porch'],
  [2, 'Driveway', 'Front of house'],
  [3, 'Garage', 'Garage'],
  [4, 'Porch', 'Porch'],
  [5, 'Garden', 'Garden'],
  [6, 'Side gate', 'Garden'],
  [7, 'Back yard', 'Garden'],
  [8, 'Hallway', 'Indoors'],
  [9, 'Patio', 'Garden'],
] as const

function node(id: string, isHub: boolean, ip: string): Record<string, unknown> {
  return {
    id,
    name: isHub ? 'Hub' : id,
    hostname: `${id}.example`,
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Example CPU',
    cpuCores: 8,
    memoryMB: 16_000,
    engines: ['openvino'],
    isHub,
    isOnline: true,
    cpuPercent: isHub ? 22.4 : 14.1,
    memoryPercent: isHub ? 38.2 : 27.6,
    uptime: 4 * 86_400_000,
    lastSeen: iso(NOW),
    localIps: [ip],
    addons: [],
    processes: [],
    categories: [],
    rootPackage: { name: '@camstack/server', version: '1.2.500' },
  }
}

export default defineFixtures({
  area: 'readme-demo',
  description: 'README shots: quiet shell, three nodes, cameras assigned to accelerators',
  handlers: {
    'alerts.getUnreadCount': 0,
    'alerts.list': [],
    'auth.listLoginMethods': [],
    'integrations.list': [
      integration('int-reolink', 'provider-reolink', 'Cameras'),
      integration('int-home', 'provider-homeassistant', 'Home'),
      integration('int-hikvision', 'provider-hikvision', 'Porch cameras'),
      integration('int-example', 'provider-example', 'Example cameras'),
    ],
    'deviceManager.getDevice': (input: { deviceId?: number }) => frontDoor(input.deviceId ?? 101),
    'deviceManager.getChildren': [],
    'deviceManager.listAll': CAMERAS.map(([id, name, location]) => ({
      id,
      stableId: `cam-${id}`,
      addonId: 'provider-example',
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
      metadata: { manufacturer: 'Example', model: 'DemoCam' },
    })),
    'nodes.topology': [
      node('hub', true, '192.0.2.10'),
      node('agent-a', false, '192.0.2.11'),
      node('agent-b', false, '192.0.2.12'),
    ],
    'pipelineOrchestrator.getAgentLoad': NODES.map((id) => loadOf(id)),
    'pipelineOrchestrator.listAgentSettings': NODES.map((nodeId) => ({
      nodeId,
      settings: { detect: true, decode: true, detectWeight: 1 },
    })),
    'pipelineOrchestrator.getNodeInferenceDevices': (input: { nodeId: string }) => ({
      nodeId: input.nodeId,
      reachable: true,
      devices: devicesOf(input.nodeId).map((d) => {
        const parts = d.key.split(':')
        const backend = parts.length > 1 ? parts[0] : 'cpu'
        const device = parts.length > 1 ? parts[1] : 'cpu'
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
          defaultModelId: 'yolov9m-320-int8',
          exclusion: d.exclusion,
        }
      }),
    }),
    'pipelineOrchestrator.getEffectiveShares': {
      source: 'hardware',
      policy: 'share',
      autoPending: false,
      computedAt: NOW,
      trigger: null,
      nodes: NODES.map((nodeId) => ({
        nodeId,
        eligible: true,
        configuredPct: SHARE[nodeId] ?? 0,
        effectivePct: SHARE[nodeId] ?? 0,
        capacitySource: 'hardware',
        capacityFallback: null,
        devices: devicesOf(nodeId)
          .filter((d) => d.enabled && d.presence === 'present')
          .map((d) => ({
            deviceKey: d.key,
            eligible: d.exclusion === null,
            configuredPct: d.sharePct,
            effectivePct: d.sharePct,
          })),
      })),
      nodeWeights: Object.fromEntries(NODES.map((n) => [n, 1])),
      deviceWeights: {},
    },
    'pipelineOrchestrator.getPlacementStats': {
      policy: 'share',
      windowMs: 3_600_000,
      observedForMs: 3_600_000,
      sessionsNow: 9,
      clusterPeakSessions: 9,
      nodes: NODES.map((nodeId) => ({
        nodeId,
        sessionsNow: ATTACHED[nodeId] ?? 0,
        sessionsStarted: (ATTACHED[nodeId] ?? 0) * 4,
        observedShare: (SHARE[nodeId] ?? 0) / 100,
        peakSessions: ATTACHED[nodeId] ?? 0,
        yieldsAway: 0,
        devices: devicesOf(nodeId)
          .filter((d) => d.sessionsNow > 0)
          .map((d) => ({
            deviceKey: d.key,
            sessionsNow: d.sessionsNow,
            sessionsStarted: d.sessionsNow * 4,
            observedShare: (SHARE[nodeId] ?? 0) / 100,
          })),
      })),
      stalePins: [],
    },
    'pipelineOrchestrator.getPipelineAssignments': [
      { deviceId: 1, agentNodeId: 'hub', pinned: false },
      { deviceId: 2, agentNodeId: 'hub', pinned: false },
      { deviceId: 3, agentNodeId: 'hub', pinned: false },
      { deviceId: 4, agentNodeId: 'hub', pinned: false },
      { deviceId: 5, agentNodeId: 'agent-a', pinned: false },
      { deviceId: 6, agentNodeId: 'agent-a', pinned: false },
      { deviceId: 7, agentNodeId: 'agent-a', pinned: false },
      { deviceId: 8, agentNodeId: 'agent-b', pinned: false },
      { deviceId: 9, agentNodeId: 'agent-b', pinned: false },
    ],
    'pipelineOrchestrator.getAudioAssignments': [],
    'pipelineOrchestrator.getAudioNodeLoad': [],
    'pipelineOrchestrator.getCameraStatuses': [],
  },
})
