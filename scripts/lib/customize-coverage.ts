/**
 * Every Customize surface declared in `@camstack/types` has a renderer in the
 * admin UI (or ui-library for a hero line). Types cover what they can
 * (`Record<CustomizeCardinality, …>`, `Record<ExtensionSlotId, …>`); this reads
 * what they cannot: a catalog cap with no title, a slot or an event shape whose
 * renderer file does not name it, a stored link nobody draws.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CompositionLinkKind } from '../../packages/types/src/composition/composition-link-kinds.ts'
import type { CustomizeCatalog } from '../../packages/types/src/capabilities/customize-catalog.ts'

const CUSTOMIZE_DIR = 'packages/addon-admin-ui/src/components/device/customize'

export const CARDINALITY_RENDERER = `${CUSTOMIZE_DIR}/table/customize-rows.ts`
export const SLOT_RENDERER = `${CUSTOMIZE_DIR}/kinds/ExtensionSlotSections.tsx`
export const EVENT_CARD_DIR = `${CUSTOMIZE_DIR}/event`
export const AUTHORITY_SOURCES = [
  `${CUSTOMIZE_DIR}/assignment-availability.ts`,
  `${CUSTOMIZE_DIR}/event/event-targets.ts`,
] as const

/** Where each stored link is drawn, and a token that proves that file reads it. */
export interface LinkRenderer {
  readonly file: string
  readonly marker: string
}

export const LINK_RENDERERS: Readonly<Record<CompositionLinkKind, LinkRenderer>> = {
  'lock-door-sensor': {
    file: 'packages/ui-library/src/composites/device-controls/lock-hero-card.tsx',
    marker: 'useLockDoorSensor',
  },
  'power-source': {
    file: 'packages/addon-admin-ui/src/pages/DeviceDetail.tsx',
    marker: 'powerSource',
  },
}

export interface CoverageInput {
  readonly catalog: CustomizeCatalog
  readonly cardinalities: readonly string[]
  readonly eventShapes: readonly string[]
  readonly authorityKinds: readonly string[]
  readonly slotIds: readonly string[]
  readonly linkKinds: readonly string[]
  readonly i18nCapTitles: Readonly<Record<string, readonly string[]>>
  /** Reads a repo-relative file; null when it does not exist. */
  readonly read: (file: string) => string | null
}

export interface CoverageHit {
  readonly surface: string
  readonly message: string
}

function pascal(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function customizeCoverageHits(input: CoverageInput): readonly CoverageHit[] {
  const hits: CoverageHit[] = []
  const miss = (surface: string, message: string): void => {
    hits.push({ surface, message })
  }
  const quoted = (text: string, value: string): boolean =>
    text.includes(`'${value}'`) || text.includes(`${value}:`)

  for (const [locale, titled] of Object.entries(input.i18nCapTitles)) {
    for (const cap of Object.keys(input.catalog)) {
      if (!titled.includes(cap)) {
        miss(`cap ${cap}`, `no customize.table.caps.${cap} title in the ${locale} locale`)
      }
    }
  }

  const rows = input.read(CARDINALITY_RENDERER)
  for (const cardinality of input.cardinalities) {
    if (rows === null || !quoted(rows, cardinality)) {
      miss(`cardinality ${cardinality}`, `not named in ${CARDINALITY_RENDERER}`)
    }
  }

  for (const shape of input.eventShapes) {
    const card = `${EVENT_CARD_DIR}/Event${pascal(shape)}Card.tsx`
    if (input.read(card) === null) miss(`event shape ${shape}`, `no ${card}`)
  }

  const authoritySources = AUTHORITY_SOURCES.map((file) => input.read(file) ?? '')
  for (const kind of input.authorityKinds) {
    if (!authoritySources.some((text) => text.includes(`'${kind}'`))) {
      miss(`apply authority ${kind}`, `named in none of ${AUTHORITY_SOURCES.join(', ')}`)
    }
  }

  const slots = input.read(SLOT_RENDERER)
  for (const slot of input.slotIds) {
    if (slots === null || !quoted(slots, slot)) {
      miss(`extension slot ${slot}`, `no section in ${SLOT_RENDERER}`)
    }
  }

  const renderers = new Map<string, LinkRenderer>(Object.entries(LINK_RENDERERS))
  for (const kind of input.linkKinds) {
    const renderer = renderers.get(kind)
    if (renderer === undefined) {
      miss(`link ${kind}`, 'no entry in LINK_RENDERERS (scripts/lib/customize-coverage.ts)')
      continue
    }
    const text = input.read(renderer.file)
    if (text === null || !text.includes(renderer.marker)) {
      miss(`link ${kind}`, `${renderer.file} does not read it (${renderer.marker})`)
    }
  }
  return hits
}

export function readRepoFile(repoRoot: string, file: string): string | null {
  const full = path.join(repoRoot, file)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}
