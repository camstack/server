/**
 * Suggested CLUSTER detection defaults (rule v1): which stream profile and
 * which detection rate a camera should follow when the operator pinned
 * nothing on it. Pure.
 *
 * Rule v1, judged over the nodes that SERVE cameras only:
 *  (a) a CPU-only node suggests the `low` stream at no more than 5 fps;
 *  (b) a node never suggests `high` when its measured 4K decode capacity is
 *      below the cameras it serves (it suggests `mid`);
 *  (c) the cluster is judged on its WEAKEST serving node;
 *  (d) an unmeasured fact (`null`, D393) is no recommendation for that
 *      dimension: never a guess and never `0`.
 */
import { z } from 'zod'
import { type CamProfile, CamProfileSchema } from '../../capabilities/schemas/streaming-shared.js'
import { AcceleratorKindSchema } from '../auto-tune/plan-schemas.js'

/** The detection rate suggested for a node on a CPU-only accelerator. */
export const CPU_ONLY_DETECTION_FPS = 5
/** The detection rate suggested for a node with a real accelerator. */
export const ACCELERATED_DETECTION_FPS = 10

export const DetectionDefaultsNodeFactsSchema = z.object({
  nodeId: z.string(),
  /** The node's detection accelerator; `null` = not known. */
  accelerator: AcceleratorKindSchema.nullable(),
  /** Concurrent 4K streams the node decoded; `null` = decode not measured at 4K. */
  decode4kMaxStreams: z.number().nullable(),
  /** Cameras this node serves now. A node serving none is not judged. */
  cameras: z.number().int().min(0),
})
export type DetectionDefaultsNodeFacts = z.infer<typeof DetectionDefaultsNodeFactsSchema>

export const DetectionDefaultsReasonSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no-serving-nodes') }),
  z.object({
    kind: z.literal('cpu-only'),
    nodeId: z.string(),
    dimension: z.enum(['stream-profile', 'fps']),
  }),
  z.object({
    kind: z.literal('decode-4k-below-cameras'),
    nodeId: z.string(),
    maxStreams: z.number(),
    cameras: z.number(),
  }),
  z.object({
    kind: z.literal('unknown'),
    nodeId: z.string(),
    dimension: z.enum(['stream-profile', 'fps']),
    missing: z.enum(['accelerator', 'decode-4k']),
  }),
])
export type DetectionDefaultsReason = z.infer<typeof DetectionDefaultsReasonSchema>

export const DetectionDefaultsRecommendationSchema = z.object({
  /** `null` = no recommendation for this dimension. */
  detectionStreamProfile: CamProfileSchema.nullable(),
  detectionFps: z.number().nullable(),
  reasons: z.array(DetectionDefaultsReasonSchema).readonly(),
})
export type DetectionDefaultsRecommendation = z.infer<typeof DetectionDefaultsRecommendationSchema>

const PROFILE_RANK: Readonly<Record<CamProfile, number>> = { low: 0, mid: 1, high: 2 }
const CPU_ONLY: ReadonlySet<string> = new Set(['x86-cpu', 'arm-cpu'])

type NodeCall<T> =
  | { readonly kind: 'value'; readonly value: T }
  | { readonly kind: 'unknown'; readonly missing: 'accelerator' | 'decode-4k' }

function judgeProfile(
  node: DetectionDefaultsNodeFacts,
  reasons: DetectionDefaultsReason[],
): NodeCall<CamProfile> {
  if (node.accelerator === null) return { kind: 'unknown', missing: 'accelerator' }
  if (CPU_ONLY.has(node.accelerator)) {
    reasons.push({ kind: 'cpu-only', nodeId: node.nodeId, dimension: 'stream-profile' })
    return { kind: 'value', value: 'low' }
  }
  if (node.decode4kMaxStreams === null) return { kind: 'unknown', missing: 'decode-4k' }
  if (node.decode4kMaxStreams < node.cameras) {
    reasons.push({
      kind: 'decode-4k-below-cameras',
      nodeId: node.nodeId,
      maxStreams: node.decode4kMaxStreams,
      cameras: node.cameras,
    })
    return { kind: 'value', value: 'mid' }
  }
  return { kind: 'value', value: 'high' }
}

function judgeFps(
  node: DetectionDefaultsNodeFacts,
  reasons: DetectionDefaultsReason[],
): NodeCall<number> {
  if (node.accelerator === null) return { kind: 'unknown', missing: 'accelerator' }
  if (CPU_ONLY.has(node.accelerator)) {
    reasons.push({ kind: 'cpu-only', nodeId: node.nodeId, dimension: 'fps' })
    return { kind: 'value', value: CPU_ONLY_DETECTION_FPS }
  }
  return { kind: 'value', value: ACCELERATED_DETECTION_FPS }
}

interface NodeJudgement<T> {
  readonly nodeId: string
  readonly call: NodeCall<T>
}

/**
 * The weakest value across the serving nodes. An unknown node makes the answer
 * unknowable unless a known node already sits at the floor (nothing weaker
 * exists, so the unknown cannot lower it).
 */
function weakest<T>(
  calls: readonly NodeJudgement<T>[],
  rank: (value: T) => number,
  floor: number,
  dimension: 'stream-profile' | 'fps',
  reasons: DetectionDefaultsReason[],
): T | null {
  let best: T | null = null
  for (const { call } of calls) {
    if (call.kind !== 'value') continue
    if (best === null || rank(call.value) < rank(best)) best = call.value
  }
  const unknowns = calls.flatMap(({ nodeId, call }) =>
    call.kind === 'unknown' ? [{ nodeId, missing: call.missing }] : [],
  )
  if (unknowns.length > 0 && (best === null || rank(best) > floor)) {
    for (const u of unknowns) {
      reasons.push({ kind: 'unknown', nodeId: u.nodeId, dimension, missing: u.missing })
    }
    return null
  }
  return best
}

export function recommendDetectionDefaults(
  nodes: readonly DetectionDefaultsNodeFacts[],
): DetectionDefaultsRecommendation {
  const serving = nodes.filter((n) => n.cameras > 0)
  if (serving.length === 0) {
    return {
      detectionStreamProfile: null,
      detectionFps: null,
      reasons: [{ kind: 'no-serving-nodes' }],
    }
  }
  const reasons: DetectionDefaultsReason[] = []
  const profiles = serving.map((n) => ({ nodeId: n.nodeId, call: judgeProfile(n, reasons) }))
  const rates = serving.map((n) => ({ nodeId: n.nodeId, call: judgeFps(n, reasons) }))
  const detectionStreamProfile = weakest(
    profiles,
    (p) => PROFILE_RANK[p],
    PROFILE_RANK.low,
    'stream-profile',
    reasons,
  )
  const detectionFps = weakest(rates, (r) => r, CPU_ONLY_DETECTION_FPS, 'fps', reasons)
  return { detectionStreamProfile, detectionFps, reasons }
}
