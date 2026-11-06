import * as fs from 'node:fs'
import * as path from 'node:path'
import { CatalogFileSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'

/** `packages/` of this checkout: this file is packages/system/src/i18n/__tests__. */
const PACKAGES_DIR = path.resolve(__dirname, '../../../..')

function addonCatalogFiles(): readonly string[] {
  const files: string[] = []
  for (const pkg of fs.readdirSync(PACKAGES_DIR)) {
    if (!pkg.startsWith('addon-')) continue
    const dir = path.join(PACKAGES_DIR, pkg, 'i18n')
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) files.push(path.join(dir, f))
  }
  return files
}

describe('addon i18n catalogs', () => {
  it('finds the catalogs of the repo', () => {
    expect(addonCatalogFiles().length).toBeGreaterThan(0)
  })

  it('every packages/addon-*/i18n/*.json is a flat key -> string map the registry accepts', () => {
    const refused: string[] = []
    for (const file of addonCatalogFiles()) {
      const parsed = CatalogFileSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')))
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        refused.push(
          `${path.relative(PACKAGES_DIR, file)}: ${issue?.message ?? 'invalid'} at ${issue?.path.join('.') ?? ''}`,
        )
      }
    }
    expect(refused).toEqual([])
  })
})
