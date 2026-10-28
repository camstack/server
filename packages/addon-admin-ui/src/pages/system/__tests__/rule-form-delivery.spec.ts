import type { Target, TargetKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  deliveryParamsForSelection,
  readDeliveryValue,
  writeDeliveryValue,
} from '../rule-form-delivery'

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

const targets = [target('echo', 'speaker'), target('phone', 'push')]
const kinds = [kind('speaker', true), kind('push', false)]

describe('rule delivery params', () => {
  it('offers nothing when no selected notifier declares a parameter', () => {
    expect(deliveryParamsForSelection(['phone'], targets, kinds)).toEqual([])
  })

  it('offers the declared parameter once a declaring notifier is selected', () => {
    expect(deliveryParamsForSelection(['phone', 'echo'], targets, kinds).map((p) => p.key)).toEqual(
      ['volume'],
    )
  })

  it('writes only onto targets whose kind declares the key, and clears it', () => {
    const input = { targetIds: ['phone', 'echo'], targets, kinds, targetParams: {} }
    const written = writeDeliveryValue(input, 'volume', 60)
    expect(written).toEqual({ echo: { volume: 60 } })
    expect(readDeliveryValue(['phone', 'echo'], written, 'volume')).toBe(60)
    expect(writeDeliveryValue({ ...input, targetParams: written }, 'volume', undefined)).toEqual({})
  })

  it('keeps the other params authored on the target', () => {
    const input = {
      targetIds: ['echo'],
      targets,
      kinds,
      targetParams: { echo: { sound: 'x' } },
    }
    expect(writeDeliveryValue(input, 'volume', 10)).toEqual({ echo: { sound: 'x', volume: 10 } })
  })
})
