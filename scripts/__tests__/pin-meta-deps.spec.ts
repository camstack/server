/**
 * pin-meta-deps — unit tests for the reproducible-meta-deps transform (B1).
 * See (planning repo: superpowers/specs/2026-06-17-unraid-deploy-readiness.md).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// @ts-expect-error — plain ESM script, no .d.ts
import { computePinnedDeps, pinMetaPackage } from '../pin-meta-deps.mjs'

describe('computePinnedDeps', () => {
  const versions = new Map<string, string>([
    ['@camstack/addon-pipeline', '0.1.19'],
    ['@camstack/system', '0.1.43'],
    ['@camstack/kernel', '0.1.33'],
  ])

  it('pins @camstack/* deps to exact workspace versions', () => {
    const { deps, pinned } = computePinnedDeps(
      { '@camstack/addon-pipeline': '*', '@camstack/system': '*' },
      versions,
    )
    expect(deps).toEqual({ '@camstack/addon-pipeline': '0.1.19', '@camstack/system': '0.1.43' })
    expect(pinned.sort()).toEqual(['@camstack/addon-pipeline@0.1.19', '@camstack/system@0.1.43'])
  })

  it('leaves non-@camstack deps untouched', () => {
    const { deps } = computePinnedDeps(
      { '@camstack/kernel': '*', fastify: '^5.0.0', zod: '3.25.0' },
      versions,
    )
    expect(deps.fastify).toBe('^5.0.0')
    expect(deps.zod).toBe('3.25.0')
    expect(deps['@camstack/kernel']).toBe('0.1.33')
  })

  it('reports @camstack deps with no known workspace version and leaves them as-is', () => {
    const { deps, missing } = computePinnedDeps({ '@camstack/unknown': '*' }, versions)
    expect(deps['@camstack/unknown']).toBe('*')
    expect(missing).toEqual(['@camstack/unknown'])
  })

  it('does not mutate the input deps object', () => {
    const input = { '@camstack/system': '*' }
    computePinnedDeps(input, versions)
    expect(input['@camstack/system']).toBe('*')
  })

  it('handles a meta-package with no dependencies', () => {
    const { deps, pinned } = computePinnedDeps(undefined, versions)
    expect(deps).toEqual({})
    expect(pinned).toEqual([])
  })
})

describe('pinMetaPackage (in-place file rewrite)', () => {
  it('rewrites only @camstack/* deps to exact versions on disk', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-meta-'))
    try {
      fs.mkdirSync(path.join(repo, 'packages', 'addon-x'), { recursive: true })
      fs.writeFileSync(
        path.join(repo, 'packages', 'addon-x', 'package.json'),
        JSON.stringify({ name: '@camstack/addon-x', version: '2.3.4' }),
      )
      fs.mkdirSync(path.join(repo, 'server', 'backend'), { recursive: true })
      const metaPath = path.join(repo, 'server', 'backend', 'package.json')
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          name: '@camstack/server',
          version: '0.5.0',
          dependencies: { '@camstack/addon-x': '*', fastify: '^5.0.0' },
        }),
      )

      const report = pinMetaPackage(metaPath, repo)

      expect(report.pinned).toEqual(['@camstack/addon-x@2.3.4'])
      const rewritten = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      expect(rewritten.dependencies).toEqual({ '@camstack/addon-x': '2.3.4', fastify: '^5.0.0' })
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
