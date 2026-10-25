/**
 * Sidebar docking for addon pages (pure).
 *
 * An addon page declaration may carry `section`: a well-known section id
 * (`'detection' | 'cluster' | 'administration'`) to render inside that
 * built-in sidebar group, or any other string to create/join a CUSTOM
 * section (labelled by `sectionLabel`, first declaration wins, falling
 * back to the id). Pages without `section` land in the legacy
 * "Addon Pages" group.
 */
import type { AddonPageInfo } from '../layouts/AddonPageLoader'

export const WELL_KNOWN_PAGE_SECTIONS = ['detection', 'cluster', 'administration'] as const
export type WellKnownPageSection = (typeof WELL_KNOWN_PAGE_SECTIONS)[number]

export interface CustomPageSection {
  readonly id: string
  readonly label: string
  readonly pages: readonly AddonPageInfo[]
}

export interface PartitionedAddonPages {
  /** Pages docked into a built-in sidebar group. */
  readonly known: ReadonlyMap<WellKnownPageSection, readonly AddonPageInfo[]>
  /** Addon-created sections, in first-seen order. */
  readonly custom: readonly CustomPageSection[]
  /** Pages with no `section` — the legacy "Addon Pages" group. */
  readonly ungrouped: readonly AddonPageInfo[]
}

function isWellKnown(section: string): section is WellKnownPageSection {
  return (WELL_KNOWN_PAGE_SECTIONS as readonly string[]).includes(section)
}

export function partitionAddonPages(pages: readonly AddonPageInfo[]): PartitionedAddonPages {
  const known = new Map<WellKnownPageSection, AddonPageInfo[]>()
  const custom = new Map<string, { label: string; pages: AddonPageInfo[] }>()
  const ungrouped: AddonPageInfo[] = []

  for (const page of pages) {
    const section = page.section?.trim()
    if (section === undefined || section.length === 0) {
      ungrouped.push(page)
      continue
    }
    if (isWellKnown(section)) {
      const bucket = known.get(section) ?? []
      bucket.push(page)
      known.set(section, bucket)
      continue
    }
    const existing = custom.get(section)
    if (existing) {
      existing.pages.push(page)
    } else {
      custom.set(section, {
        label: page.sectionLabel?.trim() || section,
        pages: [page],
      })
    }
  }

  return {
    known,
    custom: [...custom.entries()].map(([id, entry]) => ({
      id,
      label: entry.label,
      pages: entry.pages,
    })),
    ungrouped,
  }
}
