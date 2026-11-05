import { describe, it, expect } from 'vitest'
import type { GroupCandidate } from '../../../agent/agent-group-runner.js'
import { spawnableAddonIds } from '../hub-spawn-gate.js'

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

describe('spawnableAddonIds (planning#447)', () => {
  const byId: Record<string, GroupCandidate> = {
    ml: candidate('ml', '@camstack/addon-ml', '1.0.0'),
    ok: candidate('ok', '@camstack/addon-ok', '3.0.0'),
    newer: candidate('newer', '@camstack/addon-newer', '1.0.0'),
  }

  it('defers an addon below the server minimum and one that needs a newer server, and logs both', () => {
    const lines: string[] = []
    const ids = spawnableAddonIds({
      addonIds: ['ml', 'ok', 'newer', 'ghost'],
      candidateOf: (id) => byId[id],
      context: {
        serverVersion: '1.2.721',
        serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0' },
        installedVersions: {
          '@camstack/addon-ml': '1.0.0',
          '@camstack/addon-ok': '3.0.0',
        },
        requiresOfDir: (dir) => (dir.endsWith('addon-newer') ? { server: '>=9.0.0' } : undefined),
      },
      log: (l) => lines.push(l),
    })
    expect(ids).toEqual(['ok', 'ghost'])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('1.0.0')
    expect(lines[0]).toContain('2.0.0')
  })
})
