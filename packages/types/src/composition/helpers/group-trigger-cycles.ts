/**
 * The loop guard of group triggers, judged at save (the composition save is the
 * only writer of both members and triggers). A trigger that listens to what its
 * own group commands would fire itself; two groups can do the same through each
 * other. Pure: the caller hands in every stored group and the one being saved.
 *
 * Graph: a group G has an edge to each of its members (G commands them — a
 * member that is itself a group has its own edges, so the walk is transitive),
 * and a source device S has an edge to group H for each trigger of H (S's event
 * commands H). A cycle through the saved group is refused, by name.
 */
import { composedDeviceStableId } from '../composition.js'
import { type CompositionSourceRef } from '../source-ref.js'
import { type GroupTrigger, triggerSourceRefs } from './group-triggers.js'
import type { GroupHelperSpec } from './spec.js'

/** One stored (or candidate) actuator group. */
export interface TriggerGroup {
  readonly blockId: string
  readonly name: string
  readonly helper: GroupHelperSpec
}

export interface GroupTriggerLoop {
  /** Where in the saved group the loop is: the trigger, or the helper when the members close it. */
  readonly path: string
  readonly message: string
}

/** How a device is named in a refusal; falls back to its stable id. */
export type DeviceNamer = (ref: CompositionSourceRef) => string | null

const COMPOSER_ADDON = 'composer'
/** Bound on the walk: a store far larger than any real one cannot stall a save. */
const MAX_VISITS = 20_000

function keyOf(ref: CompositionSourceRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

function groupRef(blockId: string): CompositionSourceRef {
  return { addonId: COMPOSER_ADDON, stableId: composedDeviceStableId(blockId) }
}

interface Edge {
  readonly to: string
  /** Set on a trigger edge: the trigger of the target group that listens to the source. */
  readonly trigger: string | null
}

interface Graph {
  readonly edges: ReadonlyMap<string, readonly Edge[]>
  readonly names: ReadonlyMap<string, string>
}

function addEdge(edges: Map<string, Edge[]>, from: string, edge: Edge): void {
  edges.set(from, [...(edges.get(from) ?? []), edge])
}

function buildGraph(groups: readonly TriggerGroup[], nameOf: DeviceNamer): Graph {
  const edges = new Map<string, Edge[]>()
  const names = new Map<string, string>()
  const note = (ref: CompositionSourceRef): void => {
    if (!names.has(keyOf(ref))) names.set(keyOf(ref), nameOf(ref) ?? ref.stableId)
  }
  for (const group of groups) {
    const self = groupRef(group.blockId)
    names.set(keyOf(self), group.name)
    for (const member of group.helper.members) {
      note(member.source)
      addEdge(edges, keyOf(self), { to: keyOf(member.source), trigger: null })
    }
    for (const trigger of group.helper.triggers ?? []) {
      if (trigger.enabled === false) continue
      for (const source of triggerSourceRefs(trigger)) {
        note(source)
        addEdge(edges, keyOf(source), { to: keyOf(self), trigger: trigger.id })
      }
    }
  }
  return { edges, names }
}

function selfLoops(group: TriggerGroup, nameOf: DeviceNamer): readonly GroupTriggerLoop[] {
  const commanded = new Set([
    keyOf(groupRef(group.blockId)),
    ...group.helper.members.map((member) => keyOf(member.source)),
  ])
  return (group.helper.triggers ?? []).flatMap((trigger, index): readonly GroupTriggerLoop[] =>
    triggerSourceRefs(trigger)
      .filter((ref) => commanded.has(keyOf(ref)))
      .map((ref) => ({
        path: `helper.triggers[${index}]`,
        message: selfMessage(trigger, nameOf(ref) ?? ref.stableId),
      })),
  )
}

function selfMessage(trigger: GroupTrigger, device: string): string {
  return `trigger "${trigger.id}" listens to "${device}", which this group commands — it would fire itself`
}

/**
 * Loops of `focus` (the group being saved): its own triggers listening to what
 * it commands, and any cycle that runs through other groups' triggers. A group
 * with no trigger can close no loop and answers nothing.
 */
export function groupTriggerLoops(
  groups: readonly TriggerGroup[],
  focusBlockId: string,
  nameOf: DeviceNamer = () => null,
): readonly GroupTriggerLoop[] {
  const focus = groups.find((group) => group.blockId === focusBlockId)
  if (focus === undefined || (focus.helper.triggers ?? []).length === 0) return []
  const own = selfLoops(focus, nameOf)
  const cycle = crossGroupCycle(groups, focus, nameOf)
  return cycle === null ? own : [...own, cycle]
}

/** A cycle through the focus group that passes at least one OTHER group. */
function crossGroupCycle(
  groups: readonly TriggerGroup[],
  focus: TriggerGroup,
  nameOf: DeviceNamer,
): GroupTriggerLoop | null {
  const graph = buildGraph(groups, nameOf)
  const start = keyOf(groupRef(focus.blockId))
  const groupKeys = new Set(groups.map((group) => keyOf(groupRef(group.blockId))))
  let visits = 0
  const walk = (
    at: string,
    path: readonly { readonly key: string; readonly via: string | null }[],
  ): readonly { readonly key: string; readonly via: string | null }[] | null => {
    for (const edge of graph.edges.get(at) ?? []) {
      visits += 1
      if (visits > MAX_VISITS) return null
      if (edge.to === start) {
        const others = path.filter((step) => step.key !== start && groupKeys.has(step.key))
        if (others.length > 0) return [...path, { key: start, via: edge.trigger }]
        continue
      }
      if (path.some((step) => step.key === edge.to)) continue
      const found = walk(edge.to, [...path, { key: edge.to, via: edge.trigger }])
      if (found !== null) return found
    }
    return null
  }
  const found = walk(start, [{ key: start, via: null }])
  if (found === null) return null
  const text = found
    .map((step) => {
      const name = graph.names.get(step.key) ?? step.key
      return step.via === null ? name : `(trigger ${step.via}) ${name}`
    })
    .join(' → ')
  const first = found[1]
  const triggerIndex = (focus.helper.triggers ?? []).findIndex((trigger) =>
    found.some((step) => step.via === trigger.id),
  )
  return {
    path:
      triggerIndex >= 0
        ? `helper.triggers[${triggerIndex}]`
        : first === undefined
          ? 'helper'
          : 'helper.members',
    message: `cycle: ${text}`,
  }
}
