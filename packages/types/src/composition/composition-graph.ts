/**
 * The field graph across every composition, and the cycles in it (D659).
 *
 * A node is ONE field of ONE device (`<addon>/<stableId>#<cap>.<field>`); an
 * edge points from a composed field to each field it reads. A cycle, direct or
 * through another composition, is refused at save by name (spec §2).
 *
 * The graph is built for ONE save: the CANDIDATE composition (the one being
 * validated) plus every STORED composition. The candidate replaces its own old
 * version, identified BY BLOCK ID wherever it sits in `stored` — whether a save
 * introduces or removes a cycle must never depend on array order. A DIFFERENT
 * block targeting the candidate's device is refused by name: one composition
 * per device (D663). Two different stored peers that (wrongly) target the same
 * device are corrupted state, not a cycle to resolve by picking one silently;
 * that is refused by name too (D391).
 *
 * A customization of an EXISTING device reads that device's NATIVE value for a
 * field it replaces or does not write ("Invert state" reads the `on` it
 * replaces): such a self-read is no edge, so it is never a cycle (D663).
 * Another composition reading that field reads the customizer's output.
 *
 * `findCompositionCycles` reports at least one cycle per cycle-SET (the DFS
 * marks a node `done` after its first expansion) — not every elementary cycle
 * through a shared node, so the path it names may AVOID the candidate while
 * one through it goes unreported. What a save refuses is therefore decided per
 * strongly connected component (`findCandidateCycles`, C-1). A dotted
 * `fieldPath` is matched only as an exact string: a write to `state.value` and
 * a read of `state` would not connect (no nested field writes exist yet).
 *
 * An item leaf is its own node, `…#consumables.items[desiccant].status`
 * (`featureFieldEntries`), so two items sharing an inner path never merge. No
 * READ can name an array element (`describeStateField` never describes one),
 * so an item node is write-only: its edges to sources are what the check needs.
 */
import {
  type Composition,
  type CompositionFieldRead,
  type CompositionSourceRef,
  compositionFeatureEnabled,
  compositionReadKey,
  compositionSourceKey,
  featureFieldEntries,
  fieldReads,
} from './composition.js'

export interface CompositionPeer {
  /** The block that stores this composition — its identity (D663). */
  readonly blockId: string
  /** The device this composition writes: `composedDeviceRef(blockId)` for a new target. */
  readonly target: CompositionSourceRef
  readonly composition: Composition
  /** `"cap.field"` keys this composition REPLACES on an existing target; its reads of them are native. */
  readonly replaced?: ReadonlySet<string>
}

export interface CompositionCycle {
  /** Node keys, first and last equal. */
  readonly path: readonly string[]
}

/** Two blocks' compositions target the same device — refused by name, never silently resolved. */
export class CompositionGraphError extends Error {}

type Edge = readonly [string, readonly string[]]

/** `"cap.field"` of every field a peer writes — the same spelling as `compositionFieldKey`. */
function writtenFields(peer: CompositionPeer): ReadonlySet<string> {
  return new Set(
    peer.composition.features.flatMap((feature) =>
      !compositionFeatureEnabled(feature) || feature.kind !== 'fields'
        ? []
        : featureFieldEntries(feature).map(({ fieldPath }) => `${feature.cap}.${fieldPath}`),
    ),
  )
}

/** A read of the peer's OWN device is an edge only when it reads the peer's own output (rule 5, D663). */
function readsComposedValue(
  peer: CompositionPeer,
  written: ReadonlySet<string>,
  read: CompositionFieldRead,
): boolean {
  if (compositionSourceKey(read.source) !== compositionSourceKey(peer.target)) return true
  const field = `${read.cap}.${read.fieldPath}`
  return written.has(field) && peer.replaced?.has(field) !== true
}

function peerEdges(peer: CompositionPeer): readonly Edge[] {
  const written = writtenFields(peer)
  return peer.composition.features.flatMap((feature): readonly Edge[] =>
    !compositionFeatureEnabled(feature) || feature.kind !== 'fields'
      ? []
      : featureFieldEntries(feature).map(
          ({ fieldPath, source }): Edge => [
            compositionReadKey({ source: peer.target, cap: feature.cap, fieldPath }),
            fieldReads(source)
              .filter((read) => readsComposedValue(peer, written, read))
              .map(compositionReadKey),
          ],
        ),
  )
}

/**
 * Every peer that actually takes part in the graph: each stored peer minus the
 * candidate's own old version (same block id — the drop happens before any
 * edge is built, so its old edges never enter the map), plus the candidate
 * itself, exactly once. Throws {@link CompositionGraphError} when a DIFFERENT
 * block targets the candidate's device, or two stored peers share a device.
 */
function resolvedPeers(
  candidate: CompositionPeer,
  stored: readonly CompositionPeer[],
): readonly CompositionPeer[] {
  const candidateKey = compositionSourceKey(candidate.target)
  const survivors = new Map<string, CompositionPeer>()
  for (const peer of stored) {
    // The candidate's OWN old version: identified by block id, never by target (D663).
    if (peer.blockId === candidate.blockId) continue
    const key = compositionSourceKey(peer.target)
    if (key === candidateKey) {
      throw new CompositionGraphError(
        `block \`${peer.blockId}\` and block \`${candidate.blockId}\` both target device \`${key}\` — one composition per device; delete or edit the existing one`,
      )
    }
    const clash = survivors.get(key)
    if (clash !== undefined) {
      throw new CompositionGraphError(
        `two stored compositions (\`${clash.blockId}\`, \`${peer.blockId}\`) both target device \`${key}\` — refusing to build the field graph`,
      )
    }
    survivors.set(key, peer)
  }
  return [...survivors.values(), candidate]
}

export function compositionEdges(
  candidate: CompositionPeer,
  stored: readonly CompositionPeer[],
): ReadonlyMap<string, readonly string[]> {
  const edges: readonly Edge[] = resolvedPeers(candidate, stored).flatMap(peerEdges)
  return new Map(edges)
}

export function findCompositionCycles(
  candidate: CompositionPeer,
  stored: readonly CompositionPeer[],
): readonly CompositionCycle[] {
  const edges = compositionEdges(candidate, stored)
  const marks = new Map<string, 'visiting' | 'done'>()
  const found = new Map<string, CompositionCycle>()
  const visit = (node: string, stack: readonly string[]): void => {
    const mark = marks.get(node)
    if (mark === 'done') return
    if (mark === 'visiting') {
      const path = [...stack.slice(stack.indexOf(node)), node]
      const id = [...new Set(path)].toSorted().join('|')
      if (!found.has(id)) found.set(id, { path })
      return
    }
    marks.set(node, 'visiting')
    for (const next of edges.get(node) ?? []) visit(next, [...stack, node])
    marks.set(node, 'done')
  }
  for (const node of edges.keys()) visit(node, [])
  return [...found.values()]
}

/** A cycle-bearing strongly connected component that holds one of the candidate's nodes. */
export interface CandidateCycle {
  /** One representative cycle through a candidate node inside the component: first and last equal. */
  readonly path: readonly string[]
  /** Every node of the component — what the save would close a loop through. */
  readonly component: ReadonlySet<string>
}

/** Tarjan's strongly connected components over every node of the graph (sources included). */
function stronglyConnected(
  edges: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  const connect = (node: string): void => {
    index.set(node, index.size)
    low.set(node, index.get(node) ?? 0)
    stack.push(node)
    onStack.add(node)
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        connect(next)
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0))
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0))
      }
    }
    if (low.get(node) !== index.get(node)) return
    const component: string[] = []
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member)
      component.push(member)
      if (member === node) break
    }
    components.push(component)
  }
  for (const node of edges.keys()) if (!index.has(node)) connect(node)
  return components
}

/** The shortest walk from `start` back to itself inside `component` (one exists: the component has a cycle). */
function cycleThrough(
  start: string,
  component: ReadonlySet<string>,
  edges: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const parent = new Map<string, string>()
  const queue: string[] = [start]
  for (let head = 0; head < queue.length; head += 1) {
    const node = queue[head]
    if (node === undefined) break
    for (const next of edges.get(node) ?? []) {
      if (next === start) {
        const chain: string[] = []
        for (
          let at: string | undefined = node;
          at !== undefined && at !== start;
          at = parent.get(at)
        )
          chain.push(at)
        return [start, ...chain.reverse(), start]
      }
      if (!component.has(next) || parent.has(next)) continue
      parent.set(next, node)
      queue.push(next)
    }
  }
  return [start, start]
}

/**
 * The cycles THIS save closes, decided per strongly connected component — never
 * per reported DFS path, which names one back-edge per revisit and can report a
 * component's cycle by a path that avoids the candidate while the one through it
 * goes unreported. A component refuses when it holds a candidate node and a
 * cycle (more than one node, or a self-loop). Components without a candidate
 * node are not this save's cycles.
 */
export function findCandidateCycles(
  candidate: CompositionPeer,
  stored: readonly CompositionPeer[],
): readonly CandidateCycle[] {
  const edges = compositionEdges(candidate, stored)
  const prefix = `${compositionSourceKey(candidate.target)}#`
  return stronglyConnected(edges).flatMap((members): readonly CandidateCycle[] => {
    const start = members.find((n) => n.startsWith(prefix))
    if (start === undefined) return []
    const component = new Set(members)
    const selfLoop = members.length === 1 && (edges.get(start) ?? []).includes(start)
    if (members.length === 1 && !selfLoop) return []
    return [{ path: cycleThrough(start, component, edges), component }]
  })
}
