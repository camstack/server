import { describe, expect, it } from 'vitest'
import {
  buildKindIconMap,
  targetsToOptions,
  type NotificationTargetOption,
} from './notification-targets-options'

const targets: readonly NotificationTargetOption[] = [
  {
    id: 't1',
    name: 'Phone',
    enabled: true,
    kind: 'ntfy',
    addonId: 'notifiers',
  },
  {
    id: 't2',
    name: 'Off target',
    enabled: false,
    kind: 'pushover',
    addonId: 'notifiers',
  },
]

describe('targetsToOptions', () => {
  it('maps kind iconUrl and disabled badge', () => {
    const icons = new Map([['notifiers:ntfy', 'https://example/ntfy.svg']])
    const options = targetsToOptions(targets, icons, undefined, 'note')
    expect(options[0]).toEqual({
      value: 't1',
      label: 'Phone',
      iconUrl: 'https://example/ntfy.svg',
    })
    expect(options[1]).toEqual({
      value: 't2',
      label: 'Off target',
      badge: 'disabled',
    })
  })

  it('prefers note badge over disabled', () => {
    const options = targetsToOptions(targets, new Map(), new Set(['t2']), 'covered')
    expect(options[1]?.badge).toBe('covered')
  })
})

describe('buildKindIconMap', () => {
  it('indexes non-empty iconUrl by addonId:kind', () => {
    const map = buildKindIconMap([
      { kind: 'ntfy', addonId: 'notifiers', iconUrl: '/i/ntfy.svg' },
      { kind: 'ha', addonId: 'ha', iconUrl: '' },
      { kind: 'x', addonId: 'y' },
    ])
    expect(map.get('notifiers:ntfy')).toBe('/i/ntfy.svg')
    expect(map.size).toBe(1)
  })
})
