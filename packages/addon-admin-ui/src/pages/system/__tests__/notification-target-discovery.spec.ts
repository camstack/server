import type { DiscoveredTarget, Target, TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  discoverableKinds,
  isAlreadyConfigured,
  newTargetsFrom,
  targetFromProposal,
} from '../notification-target-discovery'

function kind(patch: Partial<TargetKind> = {}): TargetKind {
  return {
    kind: 'alexa-echo',
    label: 'Alexa',
    icon: 'megaphone',
    addonId: 'import-alexa',
    configSchema: { sections: [] },
    supportsDiscovery: true,
    destinationKeys: ['brokerId', 'echoId'],
    caps: {
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      levels: [{ id: 'default', label: 'Default', ordinal: 3 }],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 450,
    },
    ...patch,
  }
}

function proposal(config: Record<string, unknown>, name = 'Kitchen'): DiscoveredTarget {
  return { kind: 'alexa-echo', suggestedName: name, config }
}

function saved(config: Record<string, unknown>, id = 't1', kindName = 'alexa-echo'): Target {
  return { id, name: 'Saved', kind: kindName, addonId: 'import-alexa', enabled: true, config }
}

describe('which kinds can be searched', () => {
  it('keeps only the kinds that declare discovery', () => {
    const plain = kind({ kind: 'ntfy', supportsDiscovery: false })
    expect(discoverableKinds([plain, kind()]).map((row) => row.kind)).toEqual(['alexa-echo'])
  })
})

describe('a device that already has a target', () => {
  const k = kind()

  it('matches on every destination key the proposal names', () => {
    const found = proposal({ brokerId: 'b1', echoId: 'e1' })
    expect(isAlreadyConfigured(found, [saved({ brokerId: 'b1', echoId: 'e1' })], k)).toBe(true)
    expect(isAlreadyConfigured(found, [saved({ brokerId: 'b2', echoId: 'e1' })], k)).toBe(false)
    expect(isAlreadyConfigured(found, [saved({ brokerId: 'b1', echoId: 'e2' })], k)).toBe(false)
  })

  it('treats a saved target that names no account as the same device', () => {
    const found = proposal({ brokerId: 'b1', echoId: 'e1' })
    expect(isAlreadyConfigured(found, [saved({ echoId: 'e1' })], k)).toBe(true)
  })

  it('does not match a target of another kind with the same values', () => {
    const found = proposal({ brokerId: 'b1', echoId: 'e1' })
    expect(
      isAlreadyConfigured(found, [saved({ brokerId: 'b1', echoId: 'e1' }, 't', 'ntfy')], k),
    ).toBe(false)
  })

  it('never matches when the kind names no destination key and the proposal has none to compare', () => {
    const bare = kind({ destinationKeys: undefined })
    expect(isAlreadyConfigured(proposal({ x: 1 }), [saved({ x: 1 })], bare)).toBe(false)
  })
})

describe('what the discovery dialog proposes', () => {
  it('drops every device that already has a target and keeps the rest in order', () => {
    const k = kind()
    const fresh = newTargetsFrom(
      [
        proposal({ brokerId: 'b1', echoId: 'e1' }, 'Kitchen'),
        proposal({ brokerId: 'b1', echoId: 'e2' }, 'Hall'),
      ],
      [saved({ brokerId: 'b1', echoId: 'e1' })],
      k,
    )
    expect(fresh.map((row) => row.suggestedName)).toEqual(['Hall'])
  })
})

describe('turning a proposal into a target', () => {
  it('stamps the owning addon, the kind and the proposed config, enabled', () => {
    const target = targetFromProposal(
      proposal({ brokerId: 'b1', echoId: 'e1' }, 'Hall'),
      kind(),
      'alexa-echo-1-0',
    )
    expect(target).toEqual({
      id: 'alexa-echo-1-0',
      name: 'Hall',
      kind: 'alexa-echo',
      addonId: 'import-alexa',
      enabled: true,
      config: { brokerId: 'b1', echoId: 'e1' },
    })
  })
})
