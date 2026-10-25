/**
 * A fake hub for the step matrix specs: the REAL hooks and the REAL tRPC
 * clients, over a link that answers from an in-memory store and applies every
 * write to it — so "state after save" is the state the next read returns, and
 * the specs assert on the exact writes the page makes.
 *
 * The catalog and devices are a trimmed copy of this hub's real shapes
 * (`pipelineExecutor.getSchema` / `getNodeInferenceDevices`, captured
 * 2026-10-07): hub with an iGPU and an NPU enabled and the CPU off, and the
 * N100 with one iGPU.
 */
import type { System } from '@camstack/sdk'
import type {
  CameraPipelineSettings,
  ConfigField,
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
} from '@camstack/types'
import { ConfirmDialogProvider, SystemProvider, trpc } from '@camstack/ui-library'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createTRPCClient, TRPCClientError, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter, useLocation } from 'react-router-dom'

export const V9 = 'yolov9m-320-int8'
export const Y26 = 'yolo26n-320-int8'
export const PERSON = 'minConfidencePerson'
export const NMS = 'nmsIouThreshold'

const FLOORS: readonly ConfigField[] = [
  {
    type: 'slider',
    key: PERSON,
    label: 'Min Confidence — Person',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.65,
    bindsToModel: true,
    modelApplicability: { defaultByModel: { [V9]: 0.65, [Y26]: 0.4 } },
  },
  {
    type: 'slider',
    key: NMS,
    label: 'NMS IoU threshold',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.45,
  },
]

function addon(
  id: string,
  name: string,
  slot: PipelineAddonSchema['slot'],
  inputs: readonly string[],
  outputs: readonly string[],
  models: PipelineAddonSchema['models'],
  configSchema: readonly ConfigField[] = [],
): PipelineAddonSchema {
  return {
    id,
    name,
    slot,
    inputClasses: inputs,
    outputClasses: outputs,
    childSlots: [],
    models,
    defaultModelId: models[0]?.id ?? '',
    defaultConfidence: 0.5,
    enabledByDefault: true,
    configSchema,
  }
}

const OV = { openvino: { downloaded: true, sizeMB: 20 } }

export const SCHEMA: PipelineSchema = {
  slots: [
    {
      id: 'detector',
      addons: [
        addon(
          'object-detection',
          'Object Detection',
          'detector',
          [],
          ['person', 'vehicle'],
          [
            { id: V9, name: 'YOLOv9 M 320', formats: OV },
            { id: Y26, name: 'YOLO26 N 320', formats: OV },
          ],
          FLOORS,
        ),
      ],
    },
    {
      id: 'cropper',
      addons: [
        addon(
          'face-detection',
          'Face Detection',
          'cropper',
          ['person'],
          ['face'],
          [{ id: 'yunet-2023mar', name: 'YuNet', formats: OV }],
        ),
        addon(
          'plate-detection',
          'Plate Detection',
          'cropper',
          ['vehicle'],
          ['plate'],
          [{ id: 'yolox-tiny-plate', name: 'YOLOX plate', formats: OV }],
        ),
      ],
    },
    {
      id: 'classifier',
      addons: [
        addon(
          'face-embedding',
          'Face Embedding',
          'classifier',
          ['face'],
          ['identity'],
          [{ id: 'auraface-r100', name: 'AuraFace R100', formats: OV }],
          [
            {
              type: 'slider',
              key: 'minLandmarkFaceSize',
              label: 'Min face size for recognition (detection px)',
              min: 0,
              max: 200,
              step: 1,
              default: 48,
            },
          ],
        ),
      ],
    },
  ],
} as unknown as PipelineSchema

function device(
  key: string,
  enabled: boolean,
  steps: NodeInferenceDevice['steps'] = undefined,
): NodeInferenceDevice {
  const [backend, dev] = key.includes(':') ? key.split(':') : [key, key]
  return {
    key,
    backend: backend ?? key,
    device: dev ?? key,
    format: key === 'cpu' ? 'onnx' : 'openvino',
    available: true,
    enabled,
    weight: 1,
    maxSessions: null,
    defaultModelId: V9,
    ...(steps !== undefined ? { steps } : {}),
    exclusion: enabled ? null : 'disabled',
  }
}

export interface FakeHubState {
  devices: Record<string, NodeInferenceDevice[]>
  /** `agentSettings[node].stepSettings` — the node-wide layer (D927). */
  nodeStepSettings: Record<string, Record<string, Readonly<Record<string, unknown>>>>
  camera: CameraPipelineSettings
  /**
   * The camera's root-detector pick; absent = a camera with no onboard
   * detector (the read answers `onboard.available: false`).
   */
  detectionSource?: 'pipeline' | 'onboard' | 'none'
  /** When set, the read-back waits for it — a read that lags behind the write. */
  readGate?: Promise<void>
  /** When set, the write is refused with this message. */
  refuseDetectionSource?: string
}

export function freshState(): FakeHubState {
  return {
    devices: {
      hub: [device('cpu', false), device('openvino:gpu', true), device('openvino:npu', true)],
      'agent-a': [device('openvino:gpu', true)],
    },
    nodeStepSettings: { hub: { 'object-detection': { [NMS]: 0.5 } } },
    camera: {},
  }
}

export interface FakeHubCall {
  readonly path: string
  readonly input: Readonly<Record<string, unknown>>
}

const TOPOLOGY = [
  { id: 'hub', name: 'hub', isHub: true, isOnline: true, localIps: [], addons: [] },
  {
    id: 'agent-a',
    name: 'agent-a',
    isHub: false,
    isOnline: true,
    localIps: [],
    addons: [],
  },
]

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function makeFakeHub(state: FakeHubState) {
  const calls: FakeHubCall[] = []
  const answer = (path: string, raw: unknown): unknown => {
    const input = record(raw)
    switch (path) {
      case 'nodes.topology':
        return TOPOLOGY
      case 'pipelineExecutor.getSchema':
        return SCHEMA
      case 'pipelineOrchestrator.getNodeInferenceDevices':
        return {
          nodeId: input.nodeId,
          reachable: true,
          devices: state.devices[String(input.nodeId)] ?? [],
        }
      case 'pipelineOrchestrator.listAgentSettings':
        return Object.keys(state.devices).map((nodeId) => ({
          nodeId,
          settings: { stepSettings: state.nodeStepSettings[nodeId] ?? {} },
        }))
      case 'pipelineOrchestrator.getAgentSettings':
        return {
          maxCameras: null,
          stepSettings: state.nodeStepSettings[String(input.agentNodeId)] ?? {},
        }
      case 'pipelineOrchestrator.setNodeStepSettings': {
        calls.push({ path, input })
        const node = String(input.agentNodeId)
        const layer = { ...state.nodeStepSettings[node] }
        if (input.settings === null) delete layer[String(input.addonId)]
        else layer[String(input.addonId)] = record(input.settings)
        state.nodeStepSettings = { ...state.nodeStepSettings, [node]: layer }
        return { success: true }
      }
      case 'addonSettings.getGlobalSettings':
        return null
      case 'pipelineOrchestrator.getCameraSettings':
        return state.camera
      case 'pipelineOrchestrator.setAgentInferenceDevices': {
        calls.push({ path, input })
        const nodeId = String(input.agentNodeId)
        const written = record(input.inferenceDevices)
        state.devices[nodeId] = (state.devices[nodeId] ?? []).map((d) => {
          const entry = record(written[d.key])
          const steps = record(entry.steps)
          return { ...d, steps: steps as NodeInferenceDevice['steps'] }
        })
        return { success: true }
      }
      case 'pipelineOrchestrator.setCameraStepSettings': {
        calls.push({ path, input })
        const layer = { ...state.camera.stepSettings }
        const settings = input.settings
        if (settings === null) delete layer[String(input.addonId)]
        else layer[String(input.addonId)] = record(settings)
        state.camera = { ...state.camera, stepSettings: layer }
        return { success: true }
      }
      case 'pipelineOrchestrator.getCameraDetectionSource': {
        const view = {
          source: state.detectionSource ?? 'pipeline',
          explicit: state.detectionSource !== undefined,
          onboard: {
            available: state.detectionSource !== undefined,
            geometry: 'boxed' as const,
          },
        }
        return state.readGate !== undefined ? state.readGate.then(() => view) : view
      }
      case 'pipelineOrchestrator.setCameraDetectionSource': {
        calls.push({ path, input })
        if (state.refuseDetectionSource !== undefined) {
          throw new Error(state.refuseDetectionSource)
        }
        const next = String(input.source)
        if (next === 'pipeline' || next === 'onboard' || next === 'none') {
          state.detectionSource = next
        }
        return { success: true }
      }
      case 'pipelineOrchestrator.setCameraStepToggle':
        calls.push({ path, input })
        return { success: true }
      default:
        return null
    }
  }
  const link: TRPCLink<never> =
    () =>
    ({ op }) =>
      observable((observer) => {
        if (op.type === 'subscription') return () => undefined
        // `answer` may throw (a refused write) or return a promise (a read held
        // back by `readGate`): both reach the caller the way the hub's would.
        void Promise.resolve()
          .then(() => answer(op.path, op.input))
          .then(
            (data) => {
              observer.next({ result: { type: 'data', data: data ?? null } } as never)
              observer.complete()
            },
            (err: unknown) => {
              observer.error(
                TRPCClientError.from(err instanceof Error ? err : new Error(String(err))),
              )
            },
          )
        return () => undefined
      })
  return { calls, link }
}

/** The URL the router is on — for the deep-link assertions. */
export let currentSearch = ''
function LocationProbe(): null {
  currentSearch = useLocation().search
  return null
}

export function renderWithHub(ui: ReactNode, link: TRPCLink<never>, url = '/'): ReactElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const client = trpc.createClient({ links: [link] })
  const system = {
    trpcClient: createTRPCClient({ links: [link] }),
    subscribeConnectionEvents: () => () => undefined,
    onEvent: () => () => undefined,
    subscribeEvents: () => () => undefined,
    subscribeEvent: () => () => undefined,
    subscribe: () => () => undefined,
  } as unknown as System
  return (
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <SystemProvider system={system}>
          <ConfirmDialogProvider>
            <MemoryRouter initialEntries={[url]}>
              <LocationProbe />
              {ui}
            </MemoryRouter>
          </ConfirmDialogProvider>
        </SystemProvider>
      </trpc.Provider>
    </QueryClientProvider>
  )
}
