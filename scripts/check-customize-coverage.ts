#!/usr/bin/env tsx
/**
 * Customize coverage guard (D936, D944, D984, D1004). Every Customize
 * cardinality, event shape, apply authority, extension slot, catalog cap title
 * and stored composition link declared in `@camstack/types` has a renderer in
 * the admin UI. A surface that is declared and never drawn reads as "not
 * customizable" (the lock whose door sensor showed on the container).
 *
 * Run: npx tsx scripts/check-customize-coverage.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAP_CUSTOMIZE_CATALOG } from '../packages/types/src/generated/customize-catalog.ts'
import {
  CUSTOMIZE_APPLY_AUTHORITY_KINDS,
  CUSTOMIZE_CARDINALITIES,
  CUSTOMIZE_EVENT_SHAPES,
} from '../packages/types/src/capabilities/customize-spec.ts'
import { COMPOSITION_LINK_KINDS } from '../packages/types/src/composition/composition-link-kinds.ts'
import { EXTENSION_SLOT_IDS } from '../packages/types/src/generated/extension-slots.ts'
import { customizeCoverageHits, listLinkSources, readRepoFile } from './lib/customize-coverage.ts'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function capTitles(locale: string): readonly string[] {
  const file = path.join(repoRoot, `packages/addon-admin-ui/src/i18n/${locale}.json`)
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const titles = lookup(lookup(lookup(parsed, 'customize'), 'table'), 'caps')
  return typeof titles === 'object' && titles !== null ? Object.keys(titles) : []
}

function lookup(node: unknown, key: string): unknown {
  return typeof node === 'object' && node !== null
    ? Object.entries(node).find(([k]) => k === key)?.[1]
    : undefined
}

function main(): void {
  const hits = customizeCoverageHits({
    catalog: CAP_CUSTOMIZE_CATALOG,
    cardinalities: CUSTOMIZE_CARDINALITIES,
    eventShapes: CUSTOMIZE_EVENT_SHAPES,
    authorityKinds: CUSTOMIZE_APPLY_AUTHORITY_KINDS,
    slotIds: EXTENSION_SLOT_IDS,
    linkKinds: COMPOSITION_LINK_KINDS,
    linkSources: listLinkSources(repoRoot),
    i18nCapTitles: { en: capTitles('en'), it: capTitles('it') },
    read: (file) => readRepoFile(repoRoot, file),
  })
  if (hits.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `✔ customize coverage: ${Object.keys(CAP_CUSTOMIZE_CATALOG).length} caps, ` +
        `${CUSTOMIZE_CARDINALITIES.length} cardinalities, ${EXTENSION_SLOT_IDS.length} slots, ` +
        `${COMPOSITION_LINK_KINDS.length} link kinds, each with a renderer`,
    )
    return
  }
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31m✘ customize coverage guard failed\x1b[0m')
  for (const hit of hits) {
    // eslint-disable-next-line no-console
    console.error(`    - ${hit.surface}: ${hit.message}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

main()
