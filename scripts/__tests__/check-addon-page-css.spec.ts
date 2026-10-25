/**
 * The addon-page CSS guard (D747): an addon page ships no CSS of its own at
 * runtime, so the host stylesheet must scan every page package. Model Studio
 * → Installed lost `gap-x-8` / `pl-1` / `bg-zinc-*` because admin-ui scanned
 * none of them.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BLOCK_BEGIN,
  BLOCK_END,
  coverageProblems,
  declaresAddonPage,
  expectedBlock,
  HOST_CSS,
  pageOnlyClassDefinitions,
  pagePackages,
} from '../check-addon-page-css.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

describe('addon page discovery', () => {
  it('a package is a page package only when an addon declares pages', () => {
    expect(declaresAddonPage({ camstack: { addons: [{ pages: [{ id: 'p' }] }] } })).toBe(true)
    expect(declaresAddonPage({ camstack: { addons: [{ pages: [] }, {}] } })).toBe(false)
    expect(declaresAddonPage({ name: 'x' })).toBe(false)
  })

  it('finds Model Studio among the repo page packages', () => {
    expect(pagePackages()).toContain('addon-model-studio')
  })
})

describe('coverage', () => {
  const packages = ['addon-a', 'addon-b']

  it('a stylesheet without the block fails', () => {
    expect(coverageProblems('@import "tailwindcss";', packages)).toEqual([
      `${HOST_CSS} has no addon-page-sources block`,
    ])
  })

  it('a page package missing from the block fails — the Model Studio defect', () => {
    const css = [BLOCK_BEGIN, '@source "../../addon-a/src";', BLOCK_END].join('\n')
    expect(coverageProblems(css, packages)).toEqual(['page package not scanned: addon-b'])
  })

  it('a stale entry fails', () => {
    const css = expectedBlock([...packages, 'addon-gone'])
    expect(coverageProblems(css, packages)).toEqual([
      'scanned package declares no page: addon-gone',
    ])
  })

  it('the generated block passes', () => {
    expect(coverageProblems(`x\n${expectedBlock(packages)}\ny`, packages)).toEqual([])
  })

  it('the repo host stylesheet covers every page package', () => {
    const css = fs.readFileSync(path.join(ROOT, HOST_CSS), 'utf8')
    expect(coverageProblems(css, pagePackages())).toEqual([])
  })
})

describe('page-only class definitions', () => {
  it('flags @theme / @utility / @custom-variant in a page package stylesheet', () => {
    expect(
      pageOnlyClassDefinitions([
        { file: 'a.css', css: '@import "tailwindcss";\n@theme { --color-x: red; }' },
        { file: 'b.css', css: '@utility tab-4 { tab-size: 4; }' },
        { file: 'c.css', css: '@import "tailwindcss";\n:root { color-scheme: dark; }' },
      ]),
    ).toEqual(['a.css', 'b.css'])
  })
})
