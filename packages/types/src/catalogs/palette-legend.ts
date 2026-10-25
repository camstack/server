/**
 * Legend grouping for the palette editor (D939). Subclasses sit under the
 * macro that already owns them in the taxonomy. Marks that are not kinds
 * (recording, the live cursor, the heatmap handle, face, plate) are roots.
 */
import { COCO_80_LABELS, COCO_TO_MACRO } from './coco-classmap.js'
import { getTaxonomyEntry } from './event-taxonomy.js'
import { PALETTE_ENTRY_IDS, type PaletteEntryId } from './palette-entries.js'

const LEGEND_ROOTS = [
  'person',
  'vehicle',
  'animal',
  'motion',
  'audio',
  'recording',
  'live',
  'heatmapScrub',
  'package',
  'sensor',
  'control',
  'face',
  'plate',
] as const satisfies readonly PaletteEntryId[]

const MARK_LABELS: Readonly<Record<string, string>> = {
  recording: 'Recording',
  live: 'Live cursor',
  heatmapScrub: 'Heatmap handle',
  face: 'Face',
  plate: 'Plate',
}

export interface PaletteLegendItem {
  readonly id: PaletteEntryId
  readonly label: string
}

export interface PaletteLegendGroup {
  readonly id: PaletteEntryId
  readonly label: string
  readonly children: readonly PaletteLegendItem[]
}

function parentOf(id: string): string | null {
  const fromTaxonomy = getTaxonomyEntry(id)?.parentKind
  if (fromTaxonomy !== undefined && fromTaxonomy !== null) return fromTaxonomy
  const mapped = Object.entries(COCO_TO_MACRO.mapping).find(([key]) => key === id)?.[1]
  return mapped ?? null
}

export function paletteEntryLabel(id: string): string {
  const mark = MARK_LABELS[id]
  if (mark !== undefined) return mark
  const fromTaxonomy = getTaxonomyEntry(id)?.label
  if (fromTaxonomy !== undefined) return fromTaxonomy
  const fromCoco = COCO_80_LABELS.find((row) => row.id === id)?.name
  return fromCoco ?? id
}

/** One row per root, subclasses underneath. Every palette entry appears once. */
export function paletteLegend(): readonly PaletteLegendGroup[] {
  const roots = new Set<string>(LEGEND_ROOTS)
  return LEGEND_ROOTS.map((id) => {
    const children: PaletteLegendItem[] = []
    for (const entryId of PALETTE_ENTRY_IDS) {
      if (roots.has(entryId)) continue
      if (parentOf(entryId) !== id) continue
      children.push({ id: entryId, label: paletteEntryLabel(entryId) })
    }
    return { id, label: paletteEntryLabel(id), children }
  })
}
