import { inferModelProvider, type CustomModelDescriptor, type ModelFormat } from '@camstack/types'
import { parseDisplayName } from './display-name.js'
import type { z } from 'zod'
import type {
  ModelAvailabilityMapSchema,
  ModelFormatPresenceSchema,
  ModelNodeAvailabilitySchema,
} from './model-studio-actions.js'

type AvailabilityMap = z.infer<typeof ModelAvailabilityMapSchema>
type NodeAvailability = z.infer<typeof ModelNodeAvailabilitySchema>
type FormatPresence = z.infer<typeof ModelFormatPresenceSchema>

/**
 * Record that `modelId` now has `format` on `nodeId`. Merges into the node's
 * formats map — never drops a sibling format on the same node.
 */
export function upsertAvailabilityFormat(
  map: AvailabilityMap,
  modelId: string,
  nodeId: string,
  format: ModelFormat,
  presence: FormatPresence,
): AvailabilityMap {
  const prevNode: NodeAvailability = map[modelId]?.[nodeId] ?? { formats: {} }
  return {
    ...map,
    [modelId]: {
      ...map[modelId],
      [nodeId]: {
        formats: { ...prevNode.formats, [format]: presence },
      },
    },
  }
}

/**
 * @deprecated Prefer {@link upsertAvailabilityFormat}. Kept for call sites that
 * still pass a single-format legacy shape — folds into multi-format.
 */
export function upsertAvailability(
  map: AvailabilityMap,
  modelId: string,
  nodeId: string,
  entry: { format: ModelFormat; sha256: string; bytes: number; at: number },
): AvailabilityMap {
  return upsertAvailabilityFormat(map, modelId, nodeId, entry.format, {
    sha256: entry.sha256,
    bytes: entry.bytes,
    at: entry.at,
  })
}

/**
 * Pure registry operations over the custom-model list. Kept side-effect-free
 * so they unit-test without a live `BaseAddon` context — the addon class is a
 * thin durable-state wrapper around these.
 */

/**
 * Whose name an upsert carries. `source` (the default): the name a source
 * derived — it names a NEW row, but never replaces the name an existing row
 * already has, so an operator's rename survives a re-import, a second format
 * and every engine conversion. `operator`: a name the operator typed at
 * import time — it replaces the existing one.
 */
export type UpsertNameOrigin = 'source' | 'operator'

/**
 * Insert or replace a descriptor keyed by `entry.id`. When the id already
 * exists, **formats are merged** (plugin catalog multi-format accumulate) — sibling
 * formats on the prior entry are never dropped. Returns a new array.
 */
export function upsertCustomModel(
  list: readonly CustomModelDescriptor[],
  descriptor: CustomModelDescriptor,
  nameOrigin: UpsertNameOrigin = 'source',
): CustomModelDescriptor[] {
  const prev = list.find((m) => m.entry.id === descriptor.entry.id)
  const merged: CustomModelDescriptor =
    prev === undefined
      ? descriptor
      : {
          stepId: descriptor.stepId,
          entry: {
            ...prev.entry,
            ...descriptor.entry,
            name: nameOrigin === 'operator' ? descriptor.entry.name : prev.entry.name,
            formats: { ...prev.entry.formats, ...descriptor.entry.formats },
          },
        }
  const without = list.filter((m) => m.entry.id !== descriptor.entry.id)
  return [...without, merged]
}

/** modelId → the name the row had before its first rename (what a reset restores). */
export type ImportedNames = Readonly<Record<string, string>>

export interface RenameResult {
  readonly list: CustomModelDescriptor[]
  readonly importedNames: ImportedNames
  readonly name: string
}

/**
 * Rename one IMPORTED registry row in place. Only `entry.name` changes — the
 * id, step, formats and every pin keyed by the id stay exactly as they were.
 * An empty name resets the row to the name it was imported with. Throws on an
 * unknown id, a CamStack catalog row, or a name `parseDisplayName` rejects.
 */
export function renameCustomModel(
  list: readonly CustomModelDescriptor[],
  importedNames: ImportedNames,
  modelId: string,
  rawName: string,
): RenameResult {
  const row = list.find((m) => m.entry.id === modelId)
  if (row === undefined) throw new Error(`renameCustomModel: model "${modelId}" is not registered`)
  if (!isRenameableEntry(row.entry)) {
    throw new Error(
      `renameCustomModel: "${modelId}" is a CamStack catalog model and keeps its name`,
    )
  }
  const parsed = parseDisplayName(rawName)
  if (parsed.kind === 'invalid') throw new Error(`renameCustomModel: ${parsed.reason}`)

  const original = importedNames[modelId] ?? row.entry.name
  const name = parsed.kind === 'set' ? parsed.name : original
  const nextNames: Record<string, string> = { ...importedNames }
  if (parsed.kind === 'set' && name !== original) nextNames[modelId] = original
  else delete nextNames[modelId]

  const next = list.map((m) =>
    m.entry.id === modelId ? { stepId: m.stepId, entry: { ...m.entry, name } } : m,
  )
  return { list: next, importedNames: nextNames, name }
}

/** An imported row can be renamed; a CamStack catalog model cannot. */
export function isRenameableEntry(entry: CustomModelDescriptor['entry']): boolean {
  return (
    inferModelProvider({
      id: entry.id,
      description: entry.description,
      provider: entry.provider,
    }) !== 'camstack'
  )
}

/** Drop the descriptor with the given `entry.id`. Reports whether anything changed. */
export function removeCustomModel(
  list: readonly CustomModelDescriptor[],
  modelId: string,
): { next: CustomModelDescriptor[]; removed: boolean } {
  const next = list.filter((m) => m.entry.id !== modelId)
  return { next, removed: next.length !== list.length }
}

/** Drop every node entry for `modelId` from the availability map. */
export function clearAvailability(
  map: AvailabilityMap,
  modelId: string,
): { next: AvailabilityMap; hadEntry: boolean } {
  if (map[modelId] === undefined) return { next: map, hadEntry: false }
  const next = { ...map }
  delete next[modelId]
  return { next, hadEntry: true }
}

/**
 * Drop one `(modelId, nodeId, format)` from availability. Empty nodes and empty
 * model rows are pruned so Library "On nodes" does not keep a ghost chip.
 */
export function clearAvailabilityFormat(
  map: AvailabilityMap,
  modelId: string,
  nodeId: string,
  format: ModelFormat,
): { next: AvailabilityMap; cleared: boolean } {
  const perNode = map[modelId]
  if (perNode === undefined) return { next: map, cleared: false }
  const node = perNode[nodeId]
  if (node === undefined || node.formats[format] === undefined) {
    return { next: map, cleared: false }
  }
  const formats = { ...node.formats }
  delete formats[format]
  const nextNodes = { ...perNode }
  if (Object.keys(formats).length === 0) {
    delete nextNodes[nodeId]
  } else {
    nextNodes[nodeId] = { formats }
  }
  if (Object.keys(nextNodes).length === 0) {
    const next = { ...map }
    delete next[modelId]
    return { next, cleared: true }
  }
  return { next: { ...map, [modelId]: nextNodes }, cleared: true }
}

/**
 * Drop availability rows whose modelId is not in the Library registry.
 * Orphans left Sources showing "imported" after a registry-only wipe.
 */
export function pruneOrphanAvailability(
  map: AvailabilityMap,
  registeredIds: ReadonlySet<string>,
): { next: AvailabilityMap; pruned: readonly string[] } {
  const pruned: string[] = []
  let next: AvailabilityMap | null = null
  for (const modelId of Object.keys(map)) {
    if (registeredIds.has(modelId)) continue
    if (next === null) next = { ...map }
    delete next[modelId]
    pruned.push(modelId)
  }
  return { next: next ?? map, pruned }
}

/**
 * Strip `modelId` pins from a node's `inferenceDevices.*.steps` map.
 * Settings-only step entries are kept; a step that only carried the pin is
 * removed. Returns whether anything changed.
 */
type InferenceStepPin = {
  readonly modelId?: string
  readonly settings?: Readonly<Record<string, unknown>>
  readonly jumpDeviceKey?: string
}

type InferenceDevicePin = {
  readonly enabled: boolean
  readonly weight?: number
  readonly maxSessions?: number
  readonly steps?: Readonly<Record<string, InferenceStepPin>>
}

/**
 * Rewrite step `modelId` pins according to an alias map (legacy → canonical).
 * Used when plugin catalog per-format registry ids fold onto one multi-format id.
 */
export function rewriteModelIdsInInferenceDevices(
  devices: Readonly<Record<string, InferenceDevicePin>>,
  aliases: Readonly<Record<string, string>>,
): {
  next: Record<
    string,
    {
      enabled: boolean
      weight?: number
      maxSessions?: number
      steps?: Record<
        string,
        { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
      >
    }
  >
  rewritten: number
} {
  let rewritten = 0
  const next: Record<
    string,
    {
      enabled: boolean
      weight?: number
      maxSessions?: number
      steps?: Record<
        string,
        { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
      >
    }
  > = {}
  for (const [key, device] of Object.entries(devices)) {
    const stepsIn = device.steps
    if (stepsIn === undefined) {
      next[key] = {
        enabled: device.enabled,
        ...(device.weight !== undefined ? { weight: device.weight } : {}),
        ...(device.maxSessions !== undefined ? { maxSessions: device.maxSessions } : {}),
      }
      continue
    }
    const stepsOut: Record<
      string,
      { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
    > = {}
    for (const [stepId, step] of Object.entries(stepsIn)) {
      const mapped =
        step.modelId !== undefined && aliases[step.modelId] !== undefined
          ? aliases[step.modelId]
          : undefined
      if (mapped !== undefined) rewritten += 1
      stepsOut[stepId] = {
        ...(step.modelId !== undefined ? { modelId: mapped ?? step.modelId } : {}),
        ...(step.settings !== undefined ? { settings: { ...step.settings } } : {}),
        ...(step.jumpDeviceKey !== undefined ? { jumpDeviceKey: step.jumpDeviceKey } : {}),
      }
    }
    next[key] = {
      enabled: device.enabled,
      ...(device.weight !== undefined ? { weight: device.weight } : {}),
      ...(device.maxSessions !== undefined ? { maxSessions: device.maxSessions } : {}),
      ...(Object.keys(stepsOut).length > 0 ? { steps: stepsOut } : {}),
    }
  }
  return { next, rewritten }
}

export function stripModelIdFromInferenceDevices(
  devices: Readonly<Record<string, InferenceDevicePin>>,
  modelId: string,
): {
  next: Record<
    string,
    {
      enabled: boolean
      weight?: number
      maxSessions?: number
      steps?: Record<
        string,
        { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
      >
    }
  >
  cleared: number
} {
  let cleared = 0
  const next: Record<
    string,
    {
      enabled: boolean
      weight?: number
      maxSessions?: number
      steps?: Record<
        string,
        { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
      >
    }
  > = {}
  for (const [key, device] of Object.entries(devices)) {
    const stepsIn = device.steps
    if (stepsIn === undefined) {
      next[key] = {
        enabled: device.enabled,
        ...(device.weight !== undefined ? { weight: device.weight } : {}),
        ...(device.maxSessions !== undefined ? { maxSessions: device.maxSessions } : {}),
      }
      continue
    }
    const stepsOut: Record<
      string,
      { modelId?: string; settings?: Record<string, unknown>; jumpDeviceKey?: string }
    > = {}
    for (const [stepId, step] of Object.entries(stepsIn)) {
      if (step.modelId === modelId) {
        cleared += 1
        const kept: {
          modelId?: string
          settings?: Record<string, unknown>
          jumpDeviceKey?: string
        } = {}
        if (step.settings !== undefined) kept.settings = { ...step.settings }
        if (step.jumpDeviceKey !== undefined) kept.jumpDeviceKey = step.jumpDeviceKey
        if (Object.keys(kept).length > 0) stepsOut[stepId] = kept
        continue
      }
      stepsOut[stepId] = {
        ...(step.modelId !== undefined ? { modelId: step.modelId } : {}),
        ...(step.settings !== undefined ? { settings: { ...step.settings } } : {}),
        ...(step.jumpDeviceKey !== undefined ? { jumpDeviceKey: step.jumpDeviceKey } : {}),
      }
    }
    next[key] = {
      enabled: device.enabled,
      ...(device.weight !== undefined ? { weight: device.weight } : {}),
      ...(device.maxSessions !== undefined ? { maxSessions: device.maxSessions } : {}),
      ...(Object.keys(stepsOut).length > 0 ? { steps: stepsOut } : {}),
    }
  }
  return { next, cleared }
}
