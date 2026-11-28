#!/usr/bin/env tsx
/**
 * Copies the onboarding manifest a docs checkout emitted into the CLI's bundled
 * snapshot (D1077). The docs pages are the source; this file is never edited by
 * hand. `check-onboarding-manifest.ts` fails while the two differ.
 */
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DOCS_MANIFEST_RELATIVE, SNAPSHOT_PATH, docsCheckout } from './onboarding-manifest-paths.ts'

const docs = docsCheckout()
if (docs === null) {
  process.stderr.write(
    'sync-onboarding-manifest: no docs checkout — set DOMINEVO_DOCS_DIR to the docs repository.\n',
  )
  process.exit(1)
}
const source = join(docs, DOCS_MANIFEST_RELATIVE)
if (!existsSync(source)) {
  process.stderr.write(
    `sync-onboarding-manifest: ${source} does not exist — run \`npm run gen:onboarding\` there.\n`,
  )
  process.exit(1)
}
copyFileSync(source, SNAPSHOT_PATH)
process.stdout.write(`sync-onboarding-manifest: ${SNAPSHOT_PATH} <- ${source}\n`)
