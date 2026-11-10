import type { Target, TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { declaredBy } from '../rule-form-delivery'

function target(id: string, kind: string): Target {
  return { id, name: id, kind, addonId: 'a', enabled: true, config: {} }
}
function kind(name: string, declares: boolean): TargetKind {
  return {
    kind: name,
    label: name,
    icon: 'x',
    addonId: 'a',
    supportsDiscovery: false,
    configSchema: { sections: [] },
    ...(declares
      ? {
          deliveryParams: [
            { key: 'volume', label: 'Volume', type: 'number' as const, min: 0, max: 100 },
          ],
        }
      : {}),
    caps: {
      attachments: { mediaTypes: [], mode: 'url', max: 0 },
      actions: 0,
      levels: [],
      format: ['text'],
      clickUrl: false,
      sound: false,
      ttl: false,
      bodyMaxLen: 100,
    },
  }
}

// Writing a value lives in `writeTargetParam` (rule-form-target-settings.spec):
// since #487 a declared parameter is set per target, never on every target.
const targets = [target('echo', 'speaker'), target('phone', 'push')]
const kinds = [kind('speaker', true), kind('push', false)]

describe('rule delivery params (per target, D938)', () => {
  it('offers nothing on a target whose notifier declares no parameter', () => {
    expect(declaredBy('phone', targets, kinds)).toEqual([])
  })

  it('offers the declared parameter on a target whose notifier declares it', () => {
    expect(declaredBy('echo', targets, kinds).map((p) => p.key)).toEqual(['volume'])
  })

  it('offers nothing for a target the list does not know', () => {
    expect(declaredBy('gone', targets, kinds)).toEqual([])
  })
})
