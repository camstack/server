/**
 * `filterAgentAuthoritativeRecords` — the source filter for the hub's
 * agent-readiness snapshot pull (D8 reverse leg).
 *
 * The hub hydrates its authoritative registry from an AGENT's snapshot on
 * every agent (re)connect + periodically. An agent's snapshot also
 * contains records it hydrated FROM the hub earlier (hub-origin, possibly
 * stale) — applying those back would let a stale copy regress the hub's
 * own truth. Only records the agent is AUTHORITATIVE for may flow back:
 * node-scoped records for the agent's own node, and device/global records
 * the agent emitted. Malformed entries (remote input) are dropped.
 */
import { describe, expect, it } from 'vitest'
import type { IReadinessRegistryRecord } from '@camstack/types'
import { filterAgentAuthoritativeRecords } from './agent-readiness-pull'

function rec(partial: Partial<IReadinessRegistryRecord>): IReadinessRegistryRecord {
  return {
    capName: 'pipeline-executor',
    scope: { type: 'node', nodeId: 'agent-a' },
    state: 'ready',
    generation: 'gen-a',
    epoch: 1,
    lastChange: 1_000,
    sourceNodeId: 'agent-a',
    ...partial,
  }
}

describe('filterAgentAuthoritativeRecords', () => {
  it('keeps node-scoped records for the agent own node', () => {
    const out = filterAgentAuthoritativeRecords([rec({})], 'agent-a')
    expect(out).toHaveLength(1)
  })

  it('drops node-scoped records for OTHER nodes (incl. hub-origin hydrated copies)', () => {
    const out = filterAgentAuthoritativeRecords(
      [
        rec({ scope: { type: 'node', nodeId: 'hub' }, sourceNodeId: 'hub' }),
        rec({ scope: { type: 'node', nodeId: 'mac-mini' }, sourceNodeId: 'mac-mini' }),
      ],
      'agent-a',
    )
    expect(out).toHaveLength(0)
  })

  it('keeps device/global-scoped records the agent emitted, drops foreign ones', () => {
    const out = filterAgentAuthoritativeRecords(
      [
        rec({ scope: { type: 'device', deviceId: 104 }, sourceNodeId: 'agent-a' }),
        rec({ scope: { type: 'device', deviceId: 102 }, sourceNodeId: 'hub' }),
        rec({ scope: { type: 'global' }, sourceNodeId: 'agent-a' }),
        rec({ scope: { type: 'global' }, sourceNodeId: 'hub' }),
      ],
      'agent-a',
    )
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.sourceNodeId === 'agent-a')).toBe(true)
  })

  it('drops malformed entries (remote input is validated at the boundary)', () => {
    const malformed = [
      null,
      42,
      { capName: 'x' },
      rec({ state: 'bogus' as never }),
      rec({ capName: undefined as never }),
      rec({ scope: { type: 'nope' } as never }),
    ] as unknown as readonly IReadinessRegistryRecord[]
    expect(filterAgentAuthoritativeRecords(malformed, 'agent-a')).toHaveLength(0)
  })

  it('handles a non-array input defensively', () => {
    expect(filterAgentAuthoritativeRecords(undefined as never, 'agent-a')).toHaveLength(0)
  })
})
