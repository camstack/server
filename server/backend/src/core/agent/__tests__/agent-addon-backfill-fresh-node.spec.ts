import { describe, expect, it } from 'vitest'
import { computeBackfillPlan, type NodePackageEntry } from '../agent-addon-backfill'

/**
 * A fresh node (never declared a roster to the hub) is given every hub-installed
 * package whose addons all allow an agent, at the hub version (D962).
 */

const BOOTSTRAP: ReadonlySet<string> = new Set(['@camstack/system', '@camstack/addon-agent-ui'])

function pkg(name: string, version: string | null = '1.2.14'): NodePackageEntry {
  return { name, version }
}

function planInput(overrides: Partial<Parameters<typeof computeBackfillPlan>[0]> = {}) {
  return {
    recorded: [] as readonly NodePackageEntry[],
    live: [] as readonly NodePackageEntry[],
    bootstrap: BOOTSTRAP,
    undeployed: new Set<string>(),
    retired: new Set<string>(),
    hubVersions: new Map<string, string>(),
    ...overrides,
  }
}

const placements = new Map<string, readonly ('hub-only' | 'agent-only' | 'any-node')[]>([
  ['@camstack/addon-ai', ['any-node']],
  ['@camstack/addon-terminal', ['any-node', 'any-node']],
  ['@camstack/addon-hub-thing', ['hub-only']],
  ['@camstack/addon-mixed', ['any-node', 'hub-only']],
  ['@camstack/system', ['any-node']],
])
const hubVersions = new Map([
  ['@camstack/addon-ai', '2.0.0'],
  ['@camstack/addon-terminal', '2.1.0'],
  ['@camstack/addon-hub-thing', '2.0.0'],
  ['@camstack/addon-mixed', '2.0.0'],
  ['@camstack/system', '2.0.0'],
])

describe('computeBackfillPlan — fresh node (D962)', () => {
  it('gives a node with no prior roster every any-node hub package at the hub version', () => {
    const plan = computeBackfillPlan(
      planInput({ hubVersions, freshNode: { hubPackagePlacements: placements } }),
    )
    expect(plan.targets).toEqual([
      { name: '@camstack/addon-ai', version: '2.0.0', versionSource: 'hub-installed' },
      { name: '@camstack/addon-terminal', version: '2.1.0', versionSource: 'hub-installed' },
    ])
  })

  it('never plans a hub-only package, and names why it was skipped', () => {
    const plan = computeBackfillPlan(
      planInput({ hubVersions, freshNode: { hubPackagePlacements: placements } }),
    )
    expect(plan.targets.map((t) => t.name)).not.toContain('@camstack/addon-hub-thing')
    expect(plan.skipped).toEqual([
      { name: '@camstack/addon-hub-thing', reason: 'hub-only placement' },
      { name: '@camstack/addon-mixed', reason: 'hub-only placement' },
    ])
  })

  it('leaves a node WITH a recorded roster on the history-based plan', () => {
    const plan = computeBackfillPlan(
      planInput({
        recorded: [pkg('@camstack/addon-ai')],
        hubVersions,
        freshNode: { hubPackagePlacements: placements },
      }),
    )
    expect(plan.targets.map((t) => t.name)).toEqual(['@camstack/addon-ai'])
    expect(plan.skipped).toEqual([])
  })

  it('skips bootstrap packages and ones already current', () => {
    const plan = computeBackfillPlan(
      planInput({
        live: [pkg('@camstack/addon-ai', '2.0.0')],
        hubVersions,
        freshNode: { hubPackagePlacements: placements },
      }),
    )
    expect(plan.targets.map((t) => t.name)).toEqual(['@camstack/addon-terminal'])
  })
})
