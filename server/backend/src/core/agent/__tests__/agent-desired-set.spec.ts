import { describe, expect, it } from 'vitest'
import type { AddonPlacement } from '@camstack/types'
import {
  computeDesiredSet,
  diffNodeAgainstDesired,
  type DesiredSetInput,
} from '../agent-desired-set'

/**
 * D982 — the hub owns every node's addon set. The desired set is computed from
 * the hub's facts; the node's roster is only the observation it is diffed against.
 */

const BOOTSTRAP = new Set(['@camstack/system'])

function hub(
  entries: Record<string, { version: string | null; placements: readonly AddonPlacement[] }>,
): DesiredSetInput['hubPackages'] {
  return new Map(Object.entries(entries))
}

const HUB = hub({
  '@camstack/addon-pipeline': { version: '1.2.14', placements: ['any-node'] },
  '@camstack/addon-terminal': { version: '1.0.3', placements: ['any-node'] },
  '@camstack/addon-benchmark': { version: '1.1.0', placements: ['hub-only'] },
  '@camstack/addon-admin-ui': { version: '1.4.0', placements: ['hub-only'] },
  '@camstack/addon-auth': {
    version: '1.5.0',
    placements: ['hub-only', 'hub-only'],
  },
  '@camstack/addon-mixed': {
    version: '2.0.0',
    placements: ['any-node', 'hub-only'],
  },
})
const TRACKED = new Map([['@camstack/addon-agent-ui', '1.3.0']])

function plan(
  observed: readonly { name: string; version: string | null }[],
  overrides: Partial<DesiredSetInput> = {},
  retired: ReadonlySet<string> = new Set(),
) {
  const input: DesiredSetInput = {
    hubPackages: HUB,
    trackedForAgents: TRACKED,
    tombstones: new Set(),
    bootstrap: BOOTSTRAP,
    ...overrides,
  }
  const desired = computeDesiredSet(input)
  return diffNodeAgainstDesired({
    desired,
    observed,
    retired,
    bootstrap: BOOTSTRAP,
  })
}

describe('computeDesiredSet', () => {
  it('holds every any-node hub package and every agent-tracked package at the hub version', () => {
    const { desired } = computeDesiredSet({
      hubPackages: HUB,
      trackedForAgents: TRACKED,
      tombstones: new Set(),
      bootstrap: BOOTSTRAP,
    })
    expect([...desired.keys()].sort()).toEqual([
      '@camstack/addon-agent-ui',
      '@camstack/addon-pipeline',
      '@camstack/addon-terminal',
    ])
    expect(desired.get('@camstack/addon-agent-ui')?.version).toBe('1.3.0')
  })

  it('never wants a hub-only package, nor a package that mixes a hub-only addon in', () => {
    const { desired } = computeDesiredSet({
      hubPackages: HUB,
      trackedForAgents: TRACKED,
      tombstones: new Set(),
      bootstrap: BOOTSTRAP,
    })
    expect(desired.has('@camstack/addon-benchmark')).toBe(false)
    expect(desired.has('@camstack/addon-mixed')).toBe(false)
  })

  it('keeps a tombstoned package off the node', () => {
    const { desired } = computeDesiredSet({
      hubPackages: HUB,
      trackedForAgents: TRACKED,
      tombstones: new Set(['@camstack/addon-terminal', '@camstack/addon-agent-ui']),
      bootstrap: BOOTSTRAP,
    })
    expect(desired.has('@camstack/addon-terminal')).toBe(false)
    expect(desired.has('@camstack/addon-agent-ui')).toBe(false)
  })
})

describe('diffNodeAgainstDesired', () => {
  it('installs an any-node addon added to a node that ALREADY has a roster', () => {
    const p = plan([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-agent-ui', version: '1.3.0' },
    ])
    expect(p.install.map((t) => `${t.name}@${t.version}`)).toEqual([
      '@camstack/addon-terminal@1.0.3',
    ])
    expect(p.update).toEqual([])
    expect(p.remove).toEqual([])
  })

  it('updates agent-ui from the hub-tracked version', () => {
    const p = plan([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-terminal', version: '1.0.3' },
      { name: '@camstack/addon-agent-ui', version: '1.2.0' },
    ])
    expect(p.update.map((t) => `${t.name} ${t.from} -> ${t.version}`)).toEqual([
      '@camstack/addon-agent-ui 1.2.0 -> 1.3.0',
    ])
    expect(p.install).toEqual([])
  })

  it('removes a hub-only leftover, naming the reason', () => {
    const p = plan([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-terminal', version: '1.0.3' },
      { name: '@camstack/addon-agent-ui', version: '1.3.0' },
      { name: '@camstack/addon-benchmark', version: '1.0.0' },
    ])
    expect(p.remove).toEqual([{ name: '@camstack/addon-benchmark', reason: 'hub-only placement' }])
  })

  it('removes admin-ui and auth from an agent now that they are hub-only', () => {
    const p = plan([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-terminal', version: '1.0.3' },
      { name: '@camstack/addon-agent-ui', version: '1.3.0' },
      { name: '@camstack/addon-admin-ui', version: '1.3.0' },
      { name: '@camstack/addon-auth', version: '1.4.0' },
    ])
    expect(p.remove.map((r) => r.name).sort()).toEqual([
      '@camstack/addon-admin-ui',
      '@camstack/addon-auth',
    ])
  })

  it('removes a tombstoned package still on the node and never re-installs it', () => {
    const tombstones = new Set(['@camstack/addon-terminal'])
    const on = plan([{ name: '@camstack/addon-terminal', version: '1.0.3' }], {
      tombstones,
    })
    expect(on.remove).toEqual([{ name: '@camstack/addon-terminal', reason: 'tombstoned' }])
    const off = plan([], { tombstones })
    expect(off.install.map((t) => t.name)).not.toContain('@camstack/addon-terminal')
    expect(off.remove).toEqual([])
  })

  it('leaves a package of mixed placement and unknown packages alone', () => {
    const p = plan([
      { name: '@camstack/addon-pipeline', version: '1.2.14' },
      { name: '@camstack/addon-terminal', version: '1.0.3' },
      { name: '@camstack/addon-agent-ui', version: '1.3.0' },
      { name: '@camstack/addon-mixed', version: '2.0.0' },
      { name: '@camstack/addon-stranger', version: '9.9.9' },
    ])
    expect(p.install).toEqual([])
    expect(p.update).toEqual([])
    expect(p.remove).toEqual([])
  })

  it('never touches the bootstrap set', () => {
    const p = plan([{ name: '@camstack/system', version: '0.0.1' }], {
      tombstones: new Set(['@camstack/system']),
    })
    expect(p.remove).toEqual([])
    expect(p.install.map((t) => t.name)).not.toContain('@camstack/system')
  })

  it('moves a node that is AHEAD of the hub down (D942) and skips a retired pair', () => {
    const p = plan(
      [
        { name: '@camstack/addon-pipeline', version: '1.9.0' },
        { name: '@camstack/addon-terminal', version: '1.0.3' },
        { name: '@camstack/addon-agent-ui', version: '1.3.0' },
      ],
      {},
      new Set(['@camstack/addon-pipeline']),
    )
    expect(p.update).toEqual([])
    expect(p.retired).toEqual(['@camstack/addon-pipeline'])
    const unretired = plan([
      { name: '@camstack/addon-pipeline', version: '1.9.0' },
      { name: '@camstack/addon-terminal', version: '1.0.3' },
      { name: '@camstack/addon-agent-ui', version: '1.3.0' },
    ])
    expect(unretired.update.map((t) => t.version)).toEqual(['1.2.14'])
  })
})
