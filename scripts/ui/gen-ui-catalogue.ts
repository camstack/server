#!/usr/bin/env tsx
/**
 * Writes the committed UI catalogue `docs/reference/ui-components.json` —
 * every `@camstack/ui-library` export with its props, the viewer's React Native
 * kit (`camstack/src/components/ui`), the need → component table from
 * `docs/ui/need-x-use-y.md`, and the theme's colour tokens.
 *
 *   npx tsx scripts/ui/gen-ui-catalogue.ts           write
 *   npx tsx scripts/ui/gen-ui-catalogue.ts --check   fail when stale (docs:check)
 *
 * The viewer kit is read only when the `camstack/` submodule is checked out; a
 * checkout without it keeps the committed viewer section byte for byte and
 * says so, so the file never changes just because a clone is shallow.
 *
 * The pre-commit hook regenerates it whenever ui-library source, the theme or
 * the need table is staged, so it is never a step to remember.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CATALOGUE_PATH, catalogueDrift, regenerateCatalogue } from './lib/ui-catalogue.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

function main(): void {
  if (process.argv.includes('--check')) {
    const drift = catalogueDrift(ROOT)
    if (drift.stale) {
      console.error(`✘ ${drift.message}`)
      process.exit(1)
    }
    console.log(`  ✔ ${drift.message}`)
    return
  }
  const next = regenerateCatalogue(ROOT)
  if (next.current !== next.text) fs.writeFileSync(path.join(ROOT, CATALOGUE_PATH), next.text)
  const count = next.catalogue.viewerEntries.length
  const viewer =
    next.viewerSource === 'indexed'
      ? `${count} viewer kit exports`
      : `${count} viewer kit exports CARRIED from the committed file (camstack/ submodule absent — run \`git submodule update --init camstack\` to re-read)`
  console.log(
    `ui catalogue: ${next.catalogue.entries.length} exports, ${viewer}, ${next.catalogue.needs.length} need rows → ${CATALOGUE_PATH}`,
  )
}

main()
