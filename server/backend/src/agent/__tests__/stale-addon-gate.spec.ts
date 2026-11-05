import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { PackageRequires } from '@camstack/types'
import {
  gateStaleCandidates,
  isUnreadableRequires,
  readPackageRequires,
  type StaleGateContext,
} from '../stale-addon-gate.js'
import type { GroupCandidate } from '../agent-group-runner.js'

function candidate(addonId: string, packageName: string, packageVersion: string): GroupCandidate {
  return {
    groupId: addonId,
    addonId,
    addonDir: `/addons/${packageName}`,
    version: packageVersion,
    packageName,
    packageVersion,
    capabilities: [],
  }
}

function context(overrides: Partial<StaleGateContext>): StaleGateContext {
  return {
    serverVersion: '1.2.721',
    serverRequiresAddons: {},
    installedVersions: {},
    requiresOfDir: () => undefined,
    ...overrides,
  }
}

describe('gateStaleCandidates (#346)', () => {
  it('does not spawn an addon below the minimum the running server requires', () => {
    const ml = candidate('ml', '@camstack/addon-ml', '1.0.0')
    const result = gateStaleCandidates(
      [ml],
      context({
        serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0' },
        installedVersions: { '@camstack/addon-ml': '1.0.0' },
      }),
    )
    expect(result.ready).toEqual([])
    expect(result.deferred).toHaveLength(1)
    expect(result.deferred[0]?.reason).toContain('ml')
    expect(result.deferred[0]?.reason).toContain('1.0.0')
    expect(result.deferred[0]?.reason).toContain('2.0.0')
  })

  it('does not spawn an addon whose own requires.server the server does not satisfy', () => {
    const own: PackageRequires = { server: '>=1.3.0' }
    const result = gateStaleCandidates(
      [candidate('enc', '@camstack/addon-enc', '3.0.0')],
      context({ requiresOfDir: () => own }),
    )
    expect(result.ready).toEqual([])
    expect(result.deferred[0]?.reason).toContain('1.3.0')
    expect(result.deferred[0]?.reason).toContain('1.2.721')
  })

  it('spawns an addon that meets both sides, and splits a mixed set', () => {
    const fine = candidate('ok', '@camstack/addon-ok', '2.0.0')
    const stale = candidate('ml', '@camstack/addon-ml', '1.0.0')
    const result = gateStaleCandidates(
      [fine, stale],
      context({
        serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0', '@camstack/addon-ok': '>=2.0.0' },
        installedVersions: { '@camstack/addon-ml': '1.0.0', '@camstack/addon-ok': '2.0.0' },
        requiresOfDir: () => ({ server: '>=1.2.0' }),
      }),
    )
    expect(result.ready).toEqual([fine])
    expect(result.deferred.map((d) => d.candidate.addonId)).toEqual(['ml'])
  })

  it('an unreadable server version does not defer on the addon own requires.server', () => {
    const result = gateStaleCandidates(
      [candidate('enc', '@camstack/addon-enc', '3.0.0')],
      context({ serverVersion: null, requiresOfDir: () => ({ server: '>=1.3.0' }) }),
    )
    expect(result.ready).toHaveLength(1)
  })
})

describe('an unknown fact is never a pass', () => {
  it('defers an addon whose package requires could not be read, naming why', () => {
    const x = candidate('x', '@camstack/addon-x', '1.0.0')
    const result = gateStaleCandidates(
      [x],
      context({ requiresOfDir: () => ({ unreadable: 'package.json is not valid JSON' }) }),
    )
    expect(result.ready).toEqual([])
    expect(result.deferred[0]?.reason).toContain('not valid JSON')
    expect(result.deferred[0]?.reason).toContain('1.0.0')
  })

  it('reports an addon it could not judge because the running server version is unknown', () => {
    const x = candidate('x', '@camstack/addon-x', '1.0.0')
    const result = gateStaleCandidates(
      [x],
      context({ serverVersion: null, requiresOfDir: () => ({ server: '>=1.3.0' }) }),
    )
    expect(result.ready).toEqual([x])
    expect(result.unjudged).toHaveLength(1)
    expect(result.unjudged[0]).toContain('addon-x')
    expect(result.unjudged[0]).toContain('1.3.0')
  })
})

describe('readPackageRequires reads the real package.json', () => {
  const dirWith = (content: string | null): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'requires-'))
    if (content !== null) fs.writeFileSync(path.join(dir, 'package.json'), content)
    return dir
  }

  it('returns the declared requires', () => {
    const dir = dirWith(JSON.stringify({ camstack: { requires: { server: '>=1.2.0' } } }))
    expect(readPackageRequires(dir)).toEqual({ server: '>=1.2.0' })
  })

  it('returns undefined for a package that declares none', () => {
    expect(readPackageRequires(dirWith(JSON.stringify({ name: 'x' })))).toBeUndefined()
  })

  it('marks a missing, malformed or schema-invalid package.json unreadable', () => {
    for (const dir of [
      dirWith(null),
      dirWith('{ not json'),
      dirWith(JSON.stringify({ camstack: { requires: { server: 'latest' } } })),
    ]) {
      expect(isUnreadableRequires(readPackageRequires(dir))).toBe(true)
    }
  })
})
