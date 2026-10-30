/**
 * `ops_accelerators`: per node, the inference devices it has (the cap the admin
 * UI's node page reads), the Auto-tune hardware class the node maps to, and
 * whether the measured latency table (DETECTOR_PERF) holds a row for that
 * class and accelerator.
 *
 * The table is the typed one in `@camstack/types`, never read from `docs/` at
 * runtime. A node whose hardware or devices could not be read is reported as
 * unknown, with the hub's reason — never as "no accelerator" (D315, D393).
 */
import {
  DETECTOR_PERF,
  acceleratorKindOf,
  classifyInferenceHardware,
  type AcceleratorKind,
  type HardwareClassId,
  type HardwareInfo,
} from '@camstack/types'
import type { HubClient } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import {
  cap,
  readQuery,
  withHub,
  type NoSessionResult,
  type Read,
  type RefusedResult,
} from './ops-hub.js'

const NodesSchema = z.array(
  z.looseObject({
    id: z.string(),
    isOnline: z.boolean(),
    name: z.string().optional(),
  }),
)

const HardwareSchema = z.looseObject({
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  cpuModel: z.string(),
  cpuCores: z.number(),
  totalRAM_MB: z.number(),
  availableRAM_MB: z.number(),
  gpu: z
    .looseObject({
      type: z.enum(['nvidia', 'amd', 'intel', 'apple']),
      name: z.string(),
    })
    .nullable(),
  npu: z
    .looseObject({
      type: z.enum(['apple-ane', 'intel-npu', 'amd-xdna']),
    })
    .nullable(),
})

const InferenceDevicesSchema = z.looseObject({
  reachable: z.boolean(),
  devices: z.array(
    z.looseObject({
      key: z.string(),
      backend: z.string(),
      device: z.string(),
      available: z.boolean(),
      presence: z.enum(['present', 'absent', 'unknown']).optional(),
      enabled: z.boolean(),
      exclusion: z.string().nullable(),
      defaultModelId: z.string(),
    }),
  ),
})

export const NODE_LIMIT = 30

export type BenchmarkRow =
  /** At least one measured cell exists for this class and accelerator. */
  | {
      readonly state: 'measured'
      readonly measuredCells: number
      readonly estimatedCells: number
    }
  /** Cells exist but every one is scaled from another class (D930). */
  | { readonly state: 'estimated-only'; readonly estimatedCells: number }
  | { readonly state: 'none' }

export interface DeviceReport {
  readonly key: string
  readonly backend: string
  readonly device: string
  readonly available: boolean
  readonly presence: string | null
  readonly enabled: boolean
  /** `null` = a camera-root candidate; otherwise why the dispatcher drops it. */
  readonly exclusion: string | null
  readonly defaultModelId: string
  readonly acceleratorKind: AcceleratorKind | null
  readonly benchmark: BenchmarkRow | null
}

export interface NodeAccelerators {
  readonly nodeId: string
  readonly online: boolean
  /** `null`: the node's hardware could not be read (reason in `unavailable`). */
  readonly hardwareClass: HardwareClassId | null
  readonly cpuModel: string | null
  /** `null`: the node's devices could not be read — unknown, not "none". */
  readonly devices: readonly DeviceReport[] | null
  readonly unavailable: { readonly [part: string]: string }
}

export interface OpsAcceleratorsResult {
  readonly status: 'ok'
  readonly nodes: readonly NodeAccelerators[]
  readonly nodesTruncated: number
  readonly unavailable: { readonly [part: string]: string }
}

/** Pure: does DETECTOR_PERF hold a row for this class and accelerator? */
export function benchmarkRowFor(
  hardwareClass: HardwareClassId,
  kind: AcceleratorKind | null,
): BenchmarkRow | null {
  if (kind === null) return null
  const column = DETECTOR_PERF[hardwareClass]?.[kind]
  if (column === undefined) return { state: 'none' }
  const cells = Object.values(column)
  const measured = cells.filter((c) => c.measured).length
  const estimated = cells.length - measured
  if (measured > 0)
    return {
      state: 'measured',
      measuredCells: measured,
      estimatedCells: estimated,
    }
  if (estimated > 0) return { state: 'estimated-only', estimatedCells: estimated }
  return { state: 'none' }
}

async function nodeAccelerators(
  client: HubClient,
  node: { id: string; isOnline: boolean },
): Promise<NodeAccelerators> {
  const unavailable: { [part: string]: string } = {}
  if (!node.isOnline) {
    return {
      nodeId: node.id,
      online: false,
      hardwareClass: null,
      cpuModel: null,
      devices: null,
      unavailable: { node: 'node is offline' },
    }
  }
  const [hardwareRead, devicesRead]: [
    Read<z.infer<typeof HardwareSchema>>,
    Read<z.infer<typeof InferenceDevicesSchema>>,
  ] = await Promise.all([
    readQuery(client, 'platformProbe.getHardware', { nodeId: node.id }, HardwareSchema),
    readQuery(
      client,
      'pipelineOrchestrator.getNodeInferenceDevices',
      { nodeId: node.id },
      InferenceDevicesSchema,
    ),
  ])
  let hardware: HardwareInfo | null = null
  let hardwareClass: HardwareClassId | null = null
  if (hardwareRead.ok) {
    hardware = {
      platform: hardwareRead.value.platform,
      arch: hardwareRead.value.arch,
      cpuModel: hardwareRead.value.cpuModel,
      cpuCores: hardwareRead.value.cpuCores,
      totalRAM_MB: hardwareRead.value.totalRAM_MB,
      availableRAM_MB: hardwareRead.value.availableRAM_MB,
      gpu: hardwareRead.value.gpu
        ? {
            type: hardwareRead.value.gpu.type,
            name: hardwareRead.value.gpu.name,
          }
        : null,
      npu: hardwareRead.value.npu ? { type: hardwareRead.value.npu.type } : null,
    }
    hardwareClass = classifyInferenceHardware(hardware).hardwareClass
  } else {
    unavailable['hardware'] = hardwareRead.reason
  }

  let devices: DeviceReport[] | null = null
  if (devicesRead.ok) {
    if (!devicesRead.value.reachable) {
      unavailable['devices'] = 'the node was unreachable when its devices were probed'
    } else {
      devices = devicesRead.value.devices.map((d): DeviceReport => {
        const kind = hardware ? acceleratorKindOf(d.key, hardware) : null
        return {
          key: d.key,
          backend: d.backend,
          device: d.device,
          available: d.available,
          presence: d.presence ?? null,
          enabled: d.enabled,
          exclusion: d.exclusion,
          defaultModelId: d.defaultModelId,
          acceleratorKind: kind,
          benchmark: hardwareClass ? benchmarkRowFor(hardwareClass, kind) : null,
        }
      })
    }
  } else {
    unavailable['devices'] = devicesRead.reason
  }
  return {
    nodeId: node.id,
    online: true,
    hardwareClass,
    cpuModel: hardware?.cpuModel ?? null,
    devices,
    unavailable,
  }
}

export async function opsAccelerators(
  ctx: McpContext,
): Promise<OpsAcceleratorsResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<OpsAcceleratorsResult | RefusedResult> => {
    if (connection.tier !== 'admin') {
      return {
        status: 'refused',
        reason: `nodes.topology is admin-tier and this credential is not admin-scoped.${connection.adminHint ? ` ${connection.adminHint}` : ''}`,
      }
    }
    const nodesRead = await readQuery(connection.client, 'nodes.topology', undefined, NodesSchema)
    if (!nodesRead.ok) {
      return {
        status: 'ok',
        nodes: [],
        nodesTruncated: 0,
        unavailable: { nodes: nodesRead.reason },
      }
    }
    const capped = cap(nodesRead.value, NODE_LIMIT)
    const nodes = await Promise.all(capped.items.map((n) => nodeAccelerators(connection.client, n)))
    return {
      status: 'ok',
      nodes,
      nodesTruncated: capped.truncated,
      unavailable: {},
    }
  })
}
