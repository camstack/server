/**
 * Pure grouping helper for a container's `childLayout`.
 *
 * A CONTAINER device may carry a `childLayout` directive (see
 * `ChildLayoutEntry` in `@camstack/types`) that assigns specific accessory
 * children to named accordion SECTIONS. This module partitions a parent's
 * children into the provider-declared sections plus the remaining
 * (ungrouped) children, which keep their current plain rendering.
 *
 * A child matches an entry when its `stableId` equals
 * `${parentStableId}-${entry.childKey}` — `childKey` is the child's
 * re-sync-stable accessory `stableIdSuffix`.
 *
 * Pure — no I/O, no React. Both the device-detail children list and the
 * DevicesList table-row expansion consume this single helper so the two
 * surfaces share the exact same grouping semantics.
 */
import type { ChildLayout } from '@camstack/types'
import type { DeviceItemDevice } from './helpers'

export interface ChildLayoutSection {
  readonly title: string
  readonly children: readonly DeviceItemDevice[]
  /** Whether the section renders open by default. `false` when any matched
   *  layout entry for this section declared `collapsed: true`. */
  readonly defaultOpen: boolean
  /** When `true`, the section's children render visually de-emphasized
   *  (muted). Set only on the synthetic "Disabled" section. */
  readonly muted?: boolean
}

export interface GroupedChildren {
  /** Sections ordered by first appearance in `childLayout`. */
  readonly sections: readonly ChildLayoutSection[]
  /** Children not referenced by any layout entry — render plainly, as today. */
  readonly ungrouped: readonly DeviceItemDevice[]
  /** Trailing synthetic section gathering every child whose CamStack-side
   *  `disabled` flag is set. Kept SEPARATE from `sections`/`ungrouped` so
   *  consumers render it LAST (after provider sections + ungrouped) and
   *  muted. Undefined when no child is disabled. Generic — driven purely by
   *  `child.disabled`, no provider/HA-specific input. */
  readonly disabledSection?: ChildLayoutSection
}

/** Title of the synthetic trailing section holding disabled children. Raw
 *  string (matching the provider's raw section titles); the consumer MAY
 *  localize it at render time. */
const DISABLED_SECTION_TITLE = 'Disabled'

interface SectionAccumulator {
  readonly title: string
  readonly entries: { readonly child: DeviceItemDevice; readonly order: number }[]
  /** Mutable while accumulating: set true once any matched entry of this
   *  section declares `collapsed: true`. */
  collapsed: boolean
}

/**
 * Partition a parent's children into provider-declared accordion sections +
 * the remaining (ungrouped) children. A child matches an entry when
 * `child.stableId === ${parentStableId}-${entry.childKey}`. Within a section,
 * children sort by `order ?? Number.MAX_SAFE_INTEGER` then by name. Sections
 * appear in first-seen order across `childLayout`. Pure — no I/O.
 */
export function groupChildrenByLayout(
  parentStableId: string,
  children: readonly DeviceItemDevice[],
  childLayout: ChildLayout | undefined,
): GroupedChildren {
  // FIRST pull every disabled child out of the picture: it never appears in a
  // provider section nor in `ungrouped`. The childLayout grouping below runs
  // over the enabled children only. Generic — no provider input.
  const enabled = children.filter((c) => c.disabled !== true)
  const disabled = children.filter((c) => c.disabled === true)
  const disabledSection = buildDisabledSection(disabled)

  if (childLayout === undefined || childLayout.length === 0) {
    return { sections: [], ungrouped: enabled, disabledSection }
  }

  // Index children by stableId for O(1) lookup per layout entry.
  const childByStableId = new Map<string, DeviceItemDevice>()
  for (const child of enabled) childByStableId.set(child.stableId, child)

  // Build sections in first-seen order; track which children got grouped.
  const sectionOrder: string[] = []
  const sectionByTitle = new Map<string, SectionAccumulator>()
  const groupedIds = new Set<number>()

  for (const entry of childLayout) {
    const expectedStableId = `${parentStableId}-${entry.childKey}`
    const child = childByStableId.get(expectedStableId)
    if (child === undefined) continue // unmatched childKey — ignored

    let acc = sectionByTitle.get(entry.section)
    if (acc === undefined) {
      acc = { title: entry.section, entries: [], collapsed: false }
      sectionByTitle.set(entry.section, acc)
      sectionOrder.push(entry.section)
    }
    acc.entries.push({ child, order: entry.order ?? Number.MAX_SAFE_INTEGER })
    if (entry.collapsed === true) acc.collapsed = true
    groupedIds.add(child.id)
  }

  const sections: ChildLayoutSection[] = sectionOrder.map((title) => {
    const acc = sectionByTitle.get(title)
    const entries = acc === undefined ? [] : acc.entries
    const sorted = [...entries].toSorted((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.child.name.localeCompare(b.child.name)
    })
    const defaultOpen = acc === undefined ? true : !acc.collapsed
    return { title, children: sorted.map((e) => e.child), defaultOpen }
  })

  const ungrouped = enabled.filter((c) => !groupedIds.has(c.id))

  return { sections, ungrouped, disabledSection }
}

/** Build the trailing synthetic "Disabled" section from the disabled children,
 *  sorted by name. Returns undefined when none are disabled. Collapsed by
 *  default + muted. */
function buildDisabledSection(
  disabled: readonly DeviceItemDevice[],
): ChildLayoutSection | undefined {
  if (disabled.length === 0) return undefined
  const sorted = [...disabled].toSorted((a, b) => a.name.localeCompare(b.name))
  return {
    title: DISABLED_SECTION_TITLE,
    children: sorted,
    defaultOpen: false,
    muted: true,
  }
}
