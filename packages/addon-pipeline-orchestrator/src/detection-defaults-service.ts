/**
 * Cluster detection defaults (D1104): the plan/apply pair beside Auto tune.
 *
 * The PLAN reads the per-node facts (accelerator kind, measured 4K decode,
 * cameras served), runs the rule-v1 recommender, and reports the stored
 * cluster default plus the cameras that pin either field themselves. It writes
 * nothing. The APPLY recomputes the plan, refuses a different hash (`stale`,
 * with the fresh plan) and writes the CLUSTER default only — never a camera's
 * own setting. Neither runs on its own: the operator confirms. A changed
 * default is then re-resolved for every running camera (`onApplied`).
 */
import { createHash } from 'node:crypto'
import {
  type AcceleratorKind,
  acceleratorKindOf,
  type CamProfile,
  CamProfileSchema,
  type ClusterDetectionDefaults,
  type DetectionDefaultsApplyResult,
  type DetectionDefaultsNodeFacts,
  type DetectionDefaultsPlan,
  type HardwareInfo,
  type NodeInferenceDevices,
  recommendDetectionDefaults,
} from '@dominevo/types'

/** A 4K stream is 2160 lines high; a decode cell of any other profile says nothing about 4K. */
const DECODE_4K_MIN_HEIGHT = 2160
const CPU_KINDS: ReadonlySet<AcceleratorKind> = new Set(['x86-cpu', 'arm-cpu'])

/**
 * The accelerator a node detects on: a real one when any enabled device is one,
 * `x86-cpu`/`arm-cpu` only when EVERY enabled device is a CPU, and `null` (not
 * known) when the node cannot be read or a device has no known kind.
 */
export function nodeAcceleratorOf(
  devices: NodeInferenceDevices,
  hardware: HardwareInfo | null,
): AcceleratorKind | null {
  if (!devices.reachable || hardware === null) return null
  const kinds = devices.devices
    .filter((d) => d.enabled)
    .map((d) => acceleratorKindOf(d.key, hardware))
  if (kinds.length === 0) return null
  const real = kinds.find((k): k is AcceleratorKind => k !== null && !CPU_KINDS.has(k))
  if (real !== undefined) return real
  const first = kinds[0]
  return kinds.every((k) => k !== null && CPU_KINDS.has(k)) && first !== undefined ? first : null
}

/** The 4K decode `maxStreams` of a verdict's decode cell; `null` when 4K was not measured. */
export function decode4kMaxStreams(
  decode: { readonly maxStreams: number; readonly profile: { readonly height: number } } | null,
): number | null {
  if (decode === null || decode.profile.height < DECODE_4K_MIN_HEIGHT) return null
  return decode.maxStreams
}

export interface DetectionDefaultsServiceDeps {
  /** Every node that may serve cameras. */
  readonly nodeIds: () => readonly string[]
  readonly readNodeDevices: (nodeId: string) => Promise<NodeInferenceDevices>
  readonly readHardware: (nodeId: string) => Promise<HardwareInfo | null>
  /** Cameras served per node, from the placement ledger. */
  readonly camerasByNode: () => ReadonlyMap<string, number>
  /** The decode cell of a node's capacity verdict; `null` = decode not measured. */
  readonly readDecode: (nodeId: string) => Promise<{
    readonly maxStreams: number
    readonly profile: { readonly height: number }
  } | null>
  /** The stored per-camera settings blobs, by device id. */
  readonly readCameraStores: () => Promise<ReadonlyMap<number, Record<string, unknown>>>
  readonly readClusterDefaults: () => Promise<ClusterDetectionDefaults>
  readonly writeClusterDefaults: (defaults: ClusterDetectionDefaults) => Promise<void>
  /**
   * Called only when the stored default CHANGED: re-resolves every running
   * camera's config through the settings-save rebuild path (the cached ledger
   * config would carry the old values).
   */
  readonly onApplied: () => Promise<void>
}

function pinsAnything(store: Record<string, unknown>): boolean {
  const fps = store['detectionFps']
  return (
    CamProfileSchema.safeParse(store['detectionStreamProfile']).success ||
    (typeof fps === 'number' && Number.isFinite(fps) && fps >= 0)
  )
}

export class DetectionDefaultsService {
  constructor(private readonly deps: DetectionDefaultsServiceDeps) {}

  private async nodeFacts(): Promise<readonly DetectionDefaultsNodeFacts[]> {
    const cameras = this.deps.camerasByNode()
    return await Promise.all(
      this.deps.nodeIds().map(async (nodeId): Promise<DetectionDefaultsNodeFacts> => {
        const [devices, hardware, decode] = await Promise.all([
          this.deps.readNodeDevices(nodeId),
          this.deps.readHardware(nodeId).catch(() => null),
          this.deps.readDecode(nodeId).catch(() => null),
        ])
        return {
          nodeId,
          accelerator: nodeAcceleratorOf(devices, hardware),
          decode4kMaxStreams: decode4kMaxStreams(decode),
          cameras: cameras.get(nodeId) ?? 0,
        }
      }),
    )
  }

  async plan(): Promise<DetectionDefaultsPlan> {
    const [facts, current, stores] = await Promise.all([
      this.nodeFacts(),
      this.deps.readClusterDefaults(),
      this.deps.readCameraStores(),
    ])
    const recommendation = recommendDetectionDefaults(facts)
    const deviceIds = [...stores.entries()]
      .filter(([, store]) => pinsAnything(store))
      .map(([id]) => id)
      .toSorted((a, b) => a - b)
    const planHash = createHash('sha256')
      .update(
        JSON.stringify({
          profile: recommendation.detectionStreamProfile,
          fps: recommendation.detectionFps,
          current,
        }),
      )
      .digest('hex')
      .slice(0, 16)
    return { recommendation, current, overrides: { count: deviceIds.length, deviceIds }, planHash }
  }

  async apply(input: { readonly planHash: string }): Promise<DetectionDefaultsApplyResult> {
    const plan = await this.plan()
    if (plan.planHash !== input.planHash) return { kind: 'stale', plan }
    const profile: CamProfile | null = plan.recommendation.detectionStreamProfile
    const fps = plan.recommendation.detectionFps
    // A dimension with no recommendation is left as stored (never a guess).
    const written: ClusterDetectionDefaults = {
      ...plan.current,
      ...(profile !== null ? { detectionStreamProfile: profile } : {}),
      ...(fps !== null ? { detectionFps: fps } : {}),
    }
    await this.store(plan.current, written)
    return { kind: 'applied', written }
  }

  /** Set (or clear) the stored default by hand; the code constant applies to a cleared field. */
  async set(defaults: ClusterDetectionDefaults): Promise<ClusterDetectionDefaults> {
    await this.store(await this.deps.readClusterDefaults(), defaults)
    return defaults
  }

  /** Write, and re-resolve the running cameras only when the stored value changed. */
  private async store(
    before: ClusterDetectionDefaults,
    after: ClusterDetectionDefaults,
  ): Promise<void> {
    if (
      before.detectionStreamProfile === after.detectionStreamProfile &&
      before.detectionFps === after.detectionFps
    ) {
      return
    }
    await this.deps.writeClusterDefaults(after)
    await this.deps.onApplied()
  }
}
