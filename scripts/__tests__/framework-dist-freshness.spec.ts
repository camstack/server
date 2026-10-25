/**
 * The prerequisite the AppRouter expansion never declared.
 *
 * `generate-api-types.ts` expands the hand-written core routers with the
 * SERVER tsconfig, and that tsconfig resolves `@camstack/types` /
 * `@camstack/system` through their published `dist/*.d.ts` — not their
 * sources. With a dist missing, the checker resolves the import to an error
 * type and every signature that flows through it expands to `any`; the
 * degradation guard then refuses to write and reports a symptom
 * ("output: any → 6") that names neither the cause nor a remedy.
 *
 * These cases lock the detector that turns that into an actionable failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  findUnusableFrameworkDists,
  CORE_ROUTER_FRAMEWORK_PACKAGES,
} from '../framework-dist-freshness.ts'

const PKG = { dir: 'packages/demo', name: '@camstack/demo' } as const

describe('findUnusableFrameworkDists', () => {
  let root: string

  const srcFile = (): string => path.join(root, PKG.dir, 'src/index.ts')
  const distFile = (): string => path.join(root, PKG.dir, 'dist/index.d.ts')

  const writeSrc = (mtimeMs: number): void => {
    fs.mkdirSync(path.dirname(srcFile()), { recursive: true })
    fs.writeFileSync(srcFile(), 'export const a = 1\n')
    fs.utimesSync(srcFile(), mtimeMs / 1000, mtimeMs / 1000)
  }
  const writeDist = (mtimeMs: number): void => {
    fs.mkdirSync(path.dirname(distFile()), { recursive: true })
    fs.writeFileSync(distFile(), 'export declare const a: number\n')
    fs.utimesSync(distFile(), mtimeMs / 1000, mtimeMs / 1000)
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'framework-dist-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('reports a package whose dist was never built', () => {
    writeSrc(1_000_000)
    const problems = findUnusableFrameworkDists(root, [PKG])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toBe('missing')
    expect(problems[0]?.name).toBe('@camstack/demo')
  })

  it('reports a dist older than its sources as stale', () => {
    writeDist(1_000_000)
    writeSrc(2_000_000)
    const problems = findUnusableFrameworkDists(root, [PKG])
    expect(problems).toHaveLength(1)
    expect(problems[0]?.reason).toBe('stale')
  })

  it('accepts a dist newer than every source file', () => {
    writeSrc(1_000_000)
    writeDist(2_000_000)
    expect(findUnusableFrameworkDists(root, [PKG])).toEqual([])
  })

  it('ignores generated sources the expansion itself writes back', () => {
    // `addon-api.ts` is the OUTPUT of the expansion. Counting it as an input
    // makes the dist permanently "stale" the instant codegen writes it —
    // an unbreakable rebuild loop.
    writeDist(2_000_000)
    const generated = path.join(root, PKG.dir, 'src/generated/addon-api.ts')
    fs.mkdirSync(path.dirname(generated), { recursive: true })
    fs.writeFileSync(generated, 'export type X = 1\n')
    fs.utimesSync(generated, 3_000_000 / 1000, 3_000_000 / 1000)
    writeSrc(1_000_000)
    expect(findUnusableFrameworkDists(root, [PKG])).toEqual([])
  })

  it('names the packages the core-router expansion actually resolves through', () => {
    expect(CORE_ROUTER_FRAMEWORK_PACKAGES.map((p) => p.name)).toEqual([
      '@camstack/types',
      '@camstack/system',
    ])
  })
})
