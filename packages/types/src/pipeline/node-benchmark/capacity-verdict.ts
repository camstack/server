/**
 * The node capacity verdict: how many cameras a node carries, from what was
 * MEASURED on it. Pure.
 *
 * Two planes bound a node. Detection: the node total over its devices, each
 * at the cell for the model it runs NOW ({@link capacityForModel} — the same
 * predicate the automatic shares use; a device with no cell for its current
 * model contributes nothing). Decode: the streams the node decoded at the
 * camera rate. The verdict is the smaller of the two and names which one
 * limits.
 *
 * A plane that was not measured is `null`, never `0` (D393): the verdict of
 * one measured plane is that plane's number, flagged incomplete.
 */
import { z } from 'zod'
import { capacityForModel, type NodeMeasuredCapacity } from '../load-balancing/capacity-shares.js'
import { NodeDecodeProfileSchema } from './schemas.js'

/** One device's part of the detection capacity. */
export const NodeCapacityDetectionCellSchema = z.object({
  deviceKey: z.string(),
  modelId: z.string().nullable(),
  phase: z.enum(['device', 'pipeline']),
  maxSessions: z.number(),
})
export type NodeCapacityDetectionCell = z.infer<typeof NodeCapacityDetectionCellSchema>

export const NodeDetectionCapacitySchema = z.object({
  /** The node total over `cells`. */
  maxSessions: z.number(),
  /** The newest of the cells summed. */
  measuredAtMs: z.number(),
  cells: z.array(NodeCapacityDetectionCellSchema).readonly(),
})
export type NodeDetectionCapacity = z.infer<typeof NodeDetectionCapacitySchema>

export const NodeDecodeCapacitySchema = z.object({
  /** Concurrent streams of `profile` the node decoded at the profile rate. */
  maxStreams: z.number(),
  measuredAtMs: z.number(),
  profile: NodeDecodeProfileSchema,
  /** Every stream ran on a hardware decoder (false = at least one in software). */
  hardware: z.boolean(),
  decoder: z.string(),
})
export type NodeDecodeCapacity = z.infer<typeof NodeDecodeCapacitySchema>

export const NodeCapacityLimitSchema = z.enum(['decode', 'detection'])
export type NodeCapacityLimit = z.infer<typeof NodeCapacityLimitSchema>

export const NodeCapacityVerdictSchema = z.object({
  nodeId: z.string(),
  /** null = no fresh cell for a model a device runs now. */
  detection: NodeDetectionCapacitySchema.nullable(),
  /** null = decode was not measured on this node. */
  decode: NodeDecodeCapacitySchema.nullable(),
  /** The smaller of the measured planes; null when neither is measured. */
  capacity: z.number().nullable(),
  /** Which plane limits; null unless BOTH are measured. A tie is `detection`. */
  limitedBy: NodeCapacityLimitSchema.nullable(),
  /** Both planes measured and fresh. */
  complete: z.boolean(),
})
export type NodeCapacityVerdict = z.infer<typeof NodeCapacityVerdictSchema>

export const GetNodeCapacityVerdictInputSchema = z.object({
  nodeId: z.string().optional(),
})
export type GetNodeCapacityVerdictInput = z.infer<typeof GetNodeCapacityVerdictInputSchema>

/** The model a device runs now, per Auto tune (the shares' own pick). */
export interface DeviceRunsModel {
  readonly nodeId: string
  readonly deviceKey: string
  readonly modelId: string | null
}

export interface NodeCapacityVerdictInput {
  /** Only this node; absent = every node with a fresh cell. */
  readonly nodeId?: string
  readonly runs: readonly DeviceRunsModel[]
  /** Fresh detection cells per node (`measuredCapacityFromResults`). */
  readonly measured: ReadonlyMap<string, NodeMeasuredCapacity>
  /** Fresh decode capacity per node. */
  readonly decode: ReadonlyMap<string, NodeDecodeCapacity>
}

function detectionOf(
  node: NodeMeasuredCapacity | undefined,
  runs: readonly DeviceRunsModel[],
): NodeDetectionCapacity | null {
  const cells: NodeCapacityDetectionCell[] = []
  let newest = 0
  for (const run of runs.toSorted((a, b) => a.deviceKey.localeCompare(b.deviceKey))) {
    const cell = capacityForModel(node, run.deviceKey, run.modelId)
    if (cell === undefined || cell.phase === undefined) continue
    cells.push({
      deviceKey: cell.deviceKey,
      modelId: cell.modelId,
      phase: cell.phase,
      maxSessions: Math.max(0, Math.floor(cell.maxSessions)),
    })
    newest = Math.max(newest, cell.measuredAtMs)
  }
  if (cells.length === 0) return null
  return {
    maxSessions: cells.reduce((sum, c) => sum + c.maxSessions, 0),
    measuredAtMs: newest,
    cells,
  }
}

/** One verdict per node that has any fresh cell, by node id. */
export function nodeCapacityVerdicts(
  input: NodeCapacityVerdictInput,
): readonly NodeCapacityVerdict[] {
  const nodeIds = [...new Set([...input.measured.keys(), ...input.decode.keys()])]
    .filter((id) => input.nodeId === undefined || id === input.nodeId)
    .toSorted()
  return nodeIds.map((nodeId): NodeCapacityVerdict => {
    const detection = detectionOf(
      input.measured.get(nodeId),
      input.runs.filter((r) => r.nodeId === nodeId),
    )
    const decode = input.decode.get(nodeId) ?? null
    const both = detection !== null && decode !== null
    return {
      nodeId,
      detection,
      decode,
      capacity: both
        ? Math.min(detection.maxSessions, decode.maxStreams)
        : (detection?.maxSessions ?? decode?.maxStreams ?? null),
      limitedBy: both ? (decode.maxStreams < detection.maxSessions ? 'decode' : 'detection') : null,
      complete: both,
    }
  })
}
