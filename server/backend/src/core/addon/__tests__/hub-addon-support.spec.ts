import { EventCategory } from '@camstack/types'
import { UnsupportedAddonTracker } from '@camstack/server/system'
import { describe, expect, it } from 'vitest'
import type { GroupCandidate } from '../../../agent/agent-group-runner.js'
import type { StaleGateContext } from '../../../agent/stale-addon-gate.js'
import { reportHubAddonSupport } from '../hub-addon-support.js'

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

const byId: Record<string, GroupCandidate> = {
  ml: candidate('ml', '@camstack/addon-ml', '1.0.0'),
  ok: candidate('ok', '@camstack/addon-ok', '3.0.0'),
  newer: candidate('newer', '@camstack/addon-newer', '1.0.0'),
  store: {
    ...candidate('store', '@camstack/addon-store', '1.0.0'),
    capabilities: [{ name: 'data-store-provider' }],
  },
}

function contextOf(installed: Record<string, string>): StaleGateContext {
  return {
    serverVersion: '1.2.721',
    serverRequiresAddons: { '@camstack/addon-ml': '>=2.0.0', '@camstack/addon-store': '>=2.0.0' },
    installedVersions: installed,
    requiresOfDir: (dir) => (dir.endsWith('addon-newer') ? { server: '>=9.0.0' } : undefined),
  }
}

function harness() {
  const events: Array<{ category: string; data: Record<string, unknown> }> = []
  const tracker = new UnsupportedAddonTracker({
    eventBus: { emit: (e) => void events.push({ category: e.category, data: e.data }) },
    nodeId: 'hub',
    log: () => undefined,
    settleMs: 0,
  })
  const run = (installed: Record<string, string>, ids: readonly string[]) =>
    reportHubAddonSupport({
      addonIds: ids,
      candidateOf: (id) => byId[id],
      context: contextOf(installed),
      tracker,
      installedPackages: Object.values(byId).map((c) => c.packageName),
    })
  return { events, run }
}

const INSTALLED = {
  '@camstack/addon-ml': '1.0.0',
  '@camstack/addon-ok': '3.0.0',
  '@camstack/addon-store': '1.0.0',
}

describe('reportHubAddonSupport (D1017)', () => {
  it('alerts for an addon below the server minimum and one needing a newer server, and for infrastructure alike', () => {
    const { events, run } = harness()
    run(INSTALLED, ['ml', 'ok', 'newer', 'store', 'ghost'])
    const raised = events.filter((e) => e.category === EventCategory.AddonUnsupportedVersion)
    expect(raised.map((e) => e.data['addonId']).sort()).toEqual(['ml', 'newer', 'store'])
    const ml = raised.find((e) => e.data['addonId'] === 'ml')
    expect(ml?.data).toMatchObject({
      installedVersion: '1.0.0',
      requiredMinimum: '2.0.0',
      serverVersion: '1.2.721',
    })
  })

  it('does not re-raise on the next judgement of the same installed version', () => {
    const { events, run } = harness()
    run(INSTALLED, ['ml'])
    run(INSTALLED, ['ml'])
    expect(events.filter((e) => e.category === EventCategory.AddonUnsupportedVersion)).toHaveLength(
      1,
    )
  })

  it('emits the recovery when the package is updated to a supported version', () => {
    const { events, run } = harness()
    run(INSTALLED, ['ml'])
    run({ ...INSTALLED, '@camstack/addon-ml': '2.0.0' }, ['ml'])
    expect(events.map((e) => e.category)).toEqual([
      EventCategory.AddonUnsupportedVersion,
      EventCategory.AddonUnsupportedResolved,
    ])
  })
})
