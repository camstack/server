/**
 * Turn the per-device answer of `pipelineAnalytics.listEventKindsBatch` into
 * the macro → sub tree the events filter renders.
 *
 * The whole point is the SCOPE. The filter used to build its tree from the
 * static `EVENT_TAXONOMY` dictionary, so every camera was offered every kind
 * in the system. On the live cluster the real per-camera vocabularies run from
 * 1 kind (a camera with motion only) to 53 (a doorbell camera with a package
 * zone and the audio classifier on) — the static tree described no camera.
 *
 * Derivation only: this module never invents a kind, and it has NO fallback to
 * the dictionary. When the API answers nothing the menu is empty, because an
 * empty menu is a visible failure and a full one is an invisible lie.
 */
import type { EventKindDescriptor, EventKindsForDevice } from '@camstack/types'

/** A macro lane plus the sub kinds the scoped cameras advertise under it. */
export interface KindGroup {
  readonly macro: EventKindDescriptor
  readonly subs: readonly EventKindDescriptor[]
}

/**
 * Every kind advertised by the cameras in scope.
 *
 * An EMPTY `scope` means "all cameras" — that is what the events page's camera
 * picker means when the operator has selected none, and reading it as a filter
 * instead would blank the kinds menu on first paint.
 */
export function kindsInScope(
  perDevice: readonly EventKindsForDevice[],
  scope: ReadonlySet<number>,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const entry of perDevice) {
    if (scope.size > 0 && !scope.has(entry.deviceId)) continue
    for (const kind of entry.kinds) out.add(kind.kind)
  }
  return out
}

/**
 * Descriptors for the scoped cameras, de-duplicated by kind. The first camera
 * to advertise a kind supplies its descriptor — they are built from one shared
 * dictionary server-side, so any of them carries the same color/icon/label.
 */
function descriptorsInScope(
  perDevice: readonly EventKindsForDevice[],
  scope: ReadonlySet<number>,
): ReadonlyMap<string, EventKindDescriptor> {
  const byKind = new Map<string, EventKindDescriptor>()
  for (const entry of perDevice) {
    if (scope.size > 0 && !scope.has(entry.deviceId)) continue
    for (const kind of entry.kinds) {
      if (!byKind.has(kind.kind)) byKind.set(kind.kind, kind)
    }
  }
  return byKind
}

/**
 * A macro descriptor synthesised for a parent no camera advertised directly.
 *
 * A camera can advertise `doorbell` (a `control` sub) without advertising the
 * `control` macro — the sensor kinds come from a linked device's bindings,
 * the macro from the camera's own pipeline config. Dropping such a sub would
 * hide a kind the camera really emits, so its parent lane is reconstructed
 * from the sub itself.
 */
function syntheticMacro(parentKind: string, child: EventKindDescriptor): EventKindDescriptor {
  return {
    ...child,
    kind: parentKind,
    labelKey: `eventKind.${parentKind}`,
    label: parentKind.charAt(0).toUpperCase() + parentKind.slice(1),
    iconId: parentKind,
    parentKind: null,
    level: 'macro',
  }
}

/**
 * Categories whose events carry a CLIP embedding, and are therefore reachable
 * by semantic search. Motion, audio and sensor events have no embedding — a
 * chip for them narrows a search to nothing.
 */
const SEARCHABLE_CATEGORIES: ReadonlySet<string> = new Set(['detection', 'package'])

/**
 * Macro kinds the scoped cameras advertise that the CLIP index can actually
 * answer for — the semantic-search chip row.
 *
 * Replaces a literal `['person','vehicle','animal']`, which offered the same
 * three chips on every camera and could never narrow a search to `package`.
 * Macros only: subs would run the row to a dozen chips for one camera.
 */
export function searchableMacros(
  perDevice: readonly EventKindsForDevice[],
  scope: ReadonlySet<number>,
): readonly EventKindDescriptor[] {
  return [...descriptorsInScope(perDevice, scope).values()]
    .filter((d) => d.parentKind === null && SEARCHABLE_CATEGORIES.has(d.category))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * The macro → sub tree for the cameras in scope, sorted by label at both
 * levels so the menu does not reshuffle between renders.
 */
export function buildKindGroups(
  perDevice: readonly EventKindsForDevice[],
  scope: ReadonlySet<number>,
): readonly KindGroup[] {
  const byKind = descriptorsInScope(perDevice, scope)

  const subsByParent = new Map<string, EventKindDescriptor[]>()
  const macros = new Map<string, EventKindDescriptor>()
  for (const descriptor of byKind.values()) {
    if (descriptor.parentKind === null) {
      macros.set(descriptor.kind, descriptor)
      continue
    }
    const siblings = subsByParent.get(descriptor.parentKind)
    if (siblings === undefined) subsByParent.set(descriptor.parentKind, [descriptor])
    else siblings.push(descriptor)
  }

  // Reconstruct any parent lane the scope did not carry a macro for.
  for (const [parentKind, children] of subsByParent) {
    if (macros.has(parentKind)) continue
    const first = children[0]
    if (first === undefined) continue
    macros.set(parentKind, syntheticMacro(parentKind, first))
  }

  return [...macros.values()]
    .map((macro) => ({
      macro,
      subs: [...(subsByParent.get(macro.kind) ?? [])].sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
    }))
    .sort((a, b) => a.macro.label.localeCompare(b.macro.label))
}
