/**
 * Writes the device-template function table into the public docs page.
 * The table is generated from `@camstack/types` catalogue; the check fails
 * when the committed page has drifted. The docs repo is a sibling of the
 * main checkout (`../docs`). When it is not there (CI), the check skips.
 *
 *   npx tsx scripts/generate-device-template-docs.ts
 *   npx tsx scripts/check-device-template-catalogue-docs.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { deviceTemplateCatalogueMarkdown } from '../packages/types/src/device-template-catalogue.ts'

const BEGIN = '<!-- device-template-catalogue:begin -->'
const END = '<!-- device-template-catalogue:end -->'

export function docsPagePath(repoRoot: string): string | undefined {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const main = path.dirname(common)
  const page = path.resolve(main, '../docs/content/docs/day-to-day/device-templates.mdx')
  try {
    readFileSync(page, 'utf8')
    return page
  } catch {
    return undefined
  }
}

export function withCatalogueTable(source: string, table: string): string {
  const block = `${BEGIN}\n${table}\n${END}`
  const start = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (start >= 0 && end > start) {
    return `${source.slice(0, start)}${block}${source.slice(end + END.length)}`
  }
  const heading = '## Where you use it'
  const at = source.indexOf(heading)
  if (at < 0) return `${source.trimEnd()}\n\n## Functions\n\n${block}\n`
  return `${source.slice(0, at)}## Functions\n\n${block}\n\n${source.slice(at)}`
}

export function catalogueTableIsCurrent(source: string, table: string): boolean {
  const start = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (start < 0 || end < start) return false
  const current = source.slice(start + BEGIN.length, end).trim()
  return current === table.trim()
}

function main(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const page = docsPagePath(root)
  if (page === undefined) {
    console.log('generate-device-template-docs: docs repo not present, nothing written')
    return
  }
  const table = deviceTemplateCatalogueMarkdown()
  const next = withCatalogueTable(readFileSync(page, 'utf8'), table)
  writeFileSync(page, next)
  console.log(`generate-device-template-docs: wrote ${page}`)
}

const isDirect =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirect) main()
