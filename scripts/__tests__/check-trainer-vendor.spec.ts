/**
 * The trainer vendor guard: a byte-compare alone stays green while the copy
 * cannot even be imported, if the source grew a module-level import of a
 * sibling the pair does not vendor (`inference_pool` → `pool_platform`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { unvendoredSiblingImports, type VendorPair } from '../check-trainer-vendor.js'

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'trainer-vendor-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'src', name), text)
  return root
}

function pair(vendored: readonly string[]): VendorPair {
  return { source: 'src', copy: 'copy', include: (name) => vendored.includes(name) }
}

describe('unvendoredSiblingImports', () => {
  const files = {
    'pool.py': 'import os\nimport helper\nfrom other import x\n\ndef f():\n    import lazy\n',
    'helper.py': '',
    'other.py': '',
    'lazy.py': '',
  }

  it('names every module-level sibling import that is not vendored', () => {
    const problems = unvendoredSiblingImports(tree(files), pair(['pool.py']))
    expect(problems).toHaveLength(2)
    expect(problems.join('\n')).toContain('`helper`')
    expect(problems.join('\n')).toContain('`other`')
  })

  it('ignores a function-level import and a non-sibling module', () => {
    const problems = unvendoredSiblingImports(
      tree(files),
      pair(['pool.py', 'helper.py', 'other.py']),
    )
    expect(problems).toEqual([])
  })
})
