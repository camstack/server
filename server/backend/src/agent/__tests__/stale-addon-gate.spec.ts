import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect } from 'vitest'
import { EventCategory, type PackageRequires } from '@camstack/types'
import { UnsupportedAddonTracker } from '@camstack/server/system'
import {
  judgeSupport,
  isUnreadableRequires,
  readPackageRequires,
  reportSupport,
  supportFactsOf,
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

describe('judgeSupport (#346, D1017)', () => {
  it('reports an addon below the minimum the running server requires, with both versions', () => {
    const ml = candidate('ml', '@camstack/addon-ml', '1.0.0')
    const result = judgeSupport(
      [ml],
      context({
        serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0' },
        installedVersions: { '@camstack/addon-ml': '1.0.0' },
      }),
    )
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]?.reason).toContain('ml')
    expect(result.unsupported[0]?.reason).toContain('1.0.0')
    expect(result.unsupported[0]?.reason).toContain('2.0.0')
    expect(supportFactsOf(result.unsupported[0]!, '1.2.721')).toMatchObject({
      packageName: '@camstack/addon-ml',
      installedVersion: '1.0.0',
      requiredMinimum: '2.0.0',
      serverVersion: '1.2.721',
    })
  })

  it('reports an addon whose own requires.server the server does not satisfy', () => {
    const own: PackageRequires = { server: '>=1.3.0' }
    const result = judgeSupport(
      [candidate('enc', '@camstack/addon-enc', '3.0.0')],
      context({ requiresOfDir: () => own }),
    )
    expect(result.unsupported[0]?.reason).toContain('1.3.0')
    expect(result.unsupported[0]?.reason).toContain('1.2.721')
  })

  it('reports only the unsupported addon of a mixed set', () => {
    const fine = candidate('ok', '@camstack/addon-ok', '2.0.0')
    const stale = candidate('ml', '@camstack/addon-ml', '1.0.0')
    const result = judgeSupport(
      [fine, stale],
      context({
        serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0', '@camstack/addon-ok': '>=2.0.0' },
        installedVersions: { '@camstack/addon-ml': '1.0.0', '@camstack/addon-ok': '2.0.0' },
        requiresOfDir: () => ({ server: '>=1.2.0' }),
      }),
    )
    expect(result.unsupported.map((d) => d.candidate.addonId)).toEqual(['ml'])
  })

  it('an unreadable server version does not judge the addon own requires.server', () => {
    const result = judgeSupport(
      [candidate('enc', '@camstack/addon-enc', '3.0.0')],
      context({ serverVersion: null, requiresOfDir: () => ({ server: '>=1.3.0' }) }),
    )
    expect(result.unsupported).toEqual([])
  })
})

describe('an unknown fact raises no alert', () => {
  it('leaves an addon whose package requires could not be read unjudged, naming why', () => {
    const x = candidate('x', '@camstack/addon-x', '1.0.0')
    const result = judgeSupport(
      [x],
      context({ requiresOfDir: () => ({ unreadable: 'package.json is not valid JSON' }) }),
    )
    expect(result.unsupported).toEqual([])
    expect(result.unjudged[0]).toContain('not valid JSON')
    expect(result.unjudged[0]).toContain('1.0.0')
  })

  it('reports an addon it could not judge because the running server version is unknown', () => {
    const x = candidate('x', '@camstack/addon-x', '1.0.0')
    const result = judgeSupport(
      [x],
      context({ serverVersion: null, requiresOfDir: () => ({ server: '>=1.3.0' }) }),
    )
    expect(result.unsupported).toEqual([])
    expect(result.unjudged).toHaveLength(1)
    expect(result.unjudged[0]).toContain('addon-x')
    expect(result.unjudged[0]).toContain('1.3.0')
  })
})

describe('reportSupport on an agent (D1017)', () => {
  it('raises the alert once for an addon below the minimum and resolves it after an update', () => {
    const events: Array<{ category: string; data: Record<string, unknown> }> = []
    const tracker = new UnsupportedAddonTracker({
      eventBus: { emit: (e) => void events.push({ category: e.category, data: e.data }) },
      nodeId: 'agent-1',
      log: () => undefined,
      settleMs: 0,
    })
    const ml = candidate('ml', '@camstack/addon-ml', '1.0.0')
    const run = (installed: string): void =>
      reportSupport(
        [ml],
        context({
          serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0' },
          installedVersions: { '@camstack/addon-ml': installed },
        }),
        tracker,
        () => undefined,
      )
    run('1.0.0')
    run('1.0.0')
    run('2.0.0')
    expect(events.map((e) => e.category)).toEqual([
      EventCategory.AddonUnsupportedVersion,
      EventCategory.AddonUnsupportedResolved,
    ])
    expect(events[0]?.data).toMatchObject({
      nodeId: 'agent-1',
      installedVersion: '1.0.0',
      requiredMinimum: '2.0.0',
    })
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
