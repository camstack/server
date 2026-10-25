/**
 * `add-label-keys.ts --catalog-dir` writes the catalog into the given directory
 * instead of `<pkg>/i18n` (the `server` namespace lives in packages/system/src/i18n).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const CLI = path.join(ROOT, 'scripts', 'i18n', 'add-label-keys.ts')

describe('add-label-keys --catalog-dir', () => {
  let work: string

  beforeEach(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'label-keys-'))
    fs.mkdirSync(path.join(work, 'src'))
    fs.writeFileSync(
      path.join(work, 'src', 'schema.ts'),
      "export const schema = { fields: [{ key: 'host', label: 'Host name' }] }\n",
    )
  })

  afterEach(() => {
    fs.rmSync(work, { recursive: true, force: true })
  })

  it('writes en.json and it.json into the catalog dir, not into <pkg>/i18n', () => {
    const catalog = path.join(work, 'catalog')
    execFileSync(
      'npx',
      ['tsx', CLI, '--ns', 'server', '--pkg', work, '--catalog-dir', catalog, 'src/schema.ts'],
      { cwd: ROOT, stdio: 'pipe' },
    )
    const en = JSON.parse(fs.readFileSync(path.join(catalog, 'en.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(Object.values(en)).toContain('Host name')
    expect(fs.existsSync(path.join(catalog, 'it.json'))).toBe(true)
    expect(fs.existsSync(path.join(work, 'i18n'))).toBe(false)
    const src = fs.readFileSync(path.join(work, 'src', 'schema.ts'), 'utf8')
    expect(src).toContain('labelKey: ')
  })

  it('never keys a mapOption: its label names a result field, not a text', () => {
    fs.writeFileSync(
      path.join(work, 'src', 'schema.ts'),
      "export const schema = { fields: [{ key: 'zone', label: 'Zone', mapOption: { value: 'id', label: 'name' } }] }\n",
    )
    const catalog = path.join(work, 'catalog')
    execFileSync(
      'npx',
      ['tsx', CLI, '--ns', 'server', '--pkg', work, '--catalog-dir', catalog, 'src/schema.ts'],
      { cwd: ROOT, stdio: 'pipe' },
    )
    const src = fs.readFileSync(path.join(work, 'src', 'schema.ts'), 'utf8')
    expect(src).toContain("mapOption: { value: 'id', label: 'name' }")
    const en = JSON.parse(fs.readFileSync(path.join(catalog, 'en.json'), 'utf8')) as Record<
      string,
      string
    >
    expect(Object.values(en)).not.toContain('name')
  })
})
