/**
 * Per-node capability presence (D315): a node without a provider is `absent`
 * only when the registry ANSWERED; not-yet-known is `pending`, a failed read is
 * `unknown`, and a row that cannot name its nodes is `unknown` per node.
 */
import { describe, expect, it } from 'vitest'
import { capabilityPresenceOnNode, capabilityProviderNodes } from '../use-capability-presence'

const row = (providers: string[], perNode?: { nodeId: string; providers: string[] }[]) => ({
  name: 'terminal-session',
  mode: 'singleton' as const,
  providers,
  activeProvider: providers[0] ?? null,
  disabledProviders: [],
  ...(perNode
    ? {
        perNode: perNode.map((entry) => ({
          ...entry,
          resolvedActive: entry.providers[0] ?? null,
          hasOverride: false,
        })),
      }
    : {}),
})

describe('capabilityPresenceOnNode', () => {
  it('is pending while the registry has not answered — never absent', () => {
    expect(capabilityPresenceOnNode({ status: 'pending' }, 'hub')).toBe('pending')
  })

  it('is unknown when the read failed — never absent', () => {
    expect(capabilityPresenceOnNode({ status: 'error' }, 'hub')).toBe('unknown')
  })

  it('is present on a node with a provider and absent on one without', () => {
    const answer = {
      status: 'success' as const,
      data: row(['terminal'], [{ nodeId: 'hub', providers: ['terminal'] }]),
    }
    expect(capabilityPresenceOnNode(answer, 'hub')).toBe('present')
    expect(capabilityPresenceOnNode(answer, 'edge')).toBe('absent')
  })

  it('is absent everywhere when nothing provides the capability', () => {
    expect(capabilityPresenceOnNode({ status: 'success', data: row([]) }, 'hub')).toBe('absent')
    expect(capabilityPresenceOnNode({ status: 'success', data: null }, 'hub')).toBe('absent')
  })

  it('is unknown per node when the row has providers but no per-node view', () => {
    expect(capabilityPresenceOnNode({ status: 'success', data: row(['terminal']) }, 'hub')).toBe(
      'unknown',
    )
  })
})

describe('capabilityProviderNodes', () => {
  it('carries no list while pending or after a failed read — never an empty answer', () => {
    expect(capabilityProviderNodes({ status: 'pending' })).toEqual({ state: 'pending' })
    expect(capabilityProviderNodes({ status: 'error' })).toEqual({ state: 'unknown' })
  })

  it('lists each node with a provider once, and skips a node with none', () => {
    const answer = {
      status: 'success' as const,
      data: row(
        ['terminal'],
        [
          { nodeId: 'hub', providers: ['terminal'] },
          { nodeId: 'edge', providers: [] },
          { nodeId: 'garage', providers: ['terminal'] },
        ],
      ),
    }
    expect(capabilityProviderNodes(answer)).toEqual({
      state: 'answered',
      nodeIds: ['hub', 'garage'],
    })
  })

  it('answers an empty list only when the registry said nothing provides it', () => {
    expect(capabilityProviderNodes({ status: 'success', data: null })).toEqual({
      state: 'answered',
      nodeIds: [],
    })
  })

  it('is unknown when the row has providers but cannot name their nodes', () => {
    expect(capabilityProviderNodes({ status: 'success', data: row(['terminal']) })).toEqual({
      state: 'unknown',
    })
  })
})
