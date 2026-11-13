#!/usr/bin/env tsx
/**
 * The public "Device templates" function table is generated from the catalogue.
 * Fails when the docs page (sibling repo) is present and the table is stale.
 * Skips when the docs repo is not checked out, so CI without it stays green.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deviceTemplateCatalogueMarkdown } from '../packages/types/src/device-template-catalogue.ts'
import { catalogueTableIsCurrent, docsPagePath } from './generate-device-template-docs.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const page = docsPagePath(root)
if (page === undefined) {
  console.log('check-device-template-catalogue-docs: docs repo not present, skipped')
  process.exit(0)
}
const source = readFileSync(page, 'utf8')
if (!catalogueTableIsCurrent(source, deviceTemplateCatalogueMarkdown())) {
  console.error(
    'check-device-template-catalogue-docs: the function table is stale. Run npx tsx scripts/generate-device-template-docs.ts',
  )
  process.exit(1)
}
console.log('check-device-template-catalogue-docs: OK')
