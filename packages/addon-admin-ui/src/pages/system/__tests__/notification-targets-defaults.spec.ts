import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  autoTargetName,
  defaultBrokerId,
  nextAutoName,
  targetFormDefaultKeys,
} from '../notification-targets.helpers'

const SCHEMA: ConfigUISchema = {
  sections: [
    {
      id: 'c',
      title: 'C',
      fields: [
        { type: 'broker-select', key: 'brokerId', label: 'Broker', brokerKind: 'ha' },
        {
          type: 'select',
          key: 'service',
          label: 'Service',
          options: [],
          discoverOptions: { kind: 'ha-notify', dependsOn: ['brokerId'] },
        },
      ],
    },
  ],
}

const BROKERS = [
  { id: 'b-other', kind: 'alexa', name: 'X' },
  { id: 'b-1', kind: 'ha', name: 'One' },
  { id: 'b-2', kind: 'ha', name: 'Two' },
]

describe('targetFormDefaultKeys', () => {
  it('finds the broker field and the discovered field', () => {
    const keys = targetFormDefaultKeys(SCHEMA)
    expect(keys.brokerKey).toBe('brokerId')
    expect(keys.brokerKind).toBe('ha')
    expect(keys.deviceField?.key).toBe('service')
  })
  it('is empty for a kind without them', () => {
    const keys = targetFormDefaultKeys({
      sections: [{ id: 'c', title: 'C', fields: [{ type: 'text', key: 'url', label: 'URL' }] }],
    })
    expect(keys).toEqual({ brokerKey: null, brokerKind: null, deviceField: null })
  })
})

describe('defaultBrokerId', () => {
  it('picks the first broker of the kind', () => {
    expect(defaultBrokerId(BROKERS, 'ha', undefined)).toBe('b-1')
  })
  it('never overwrites an operator choice', () => {
    expect(defaultBrokerId(BROKERS, 'ha', 'b-2')).toBeNull()
  })
  it('waits for the list to answer', () => {
    expect(defaultBrokerId(undefined, 'ha', '')).toBeNull()
  })
  it('answers null when the list has no broker of the kind', () => {
    expect(defaultBrokerId([], 'ha', '')).toBeNull()
    expect(defaultBrokerId(BROKERS, 'matter', '')).toBeNull()
  })
})

describe('target name', () => {
  it('joins notifier and device with an em dash', () => {
    expect(autoTargetName('Home Assistant', 'Pixel 7')).toBe('Home Assistant — Pixel 7')
    expect(autoTargetName('Home Assistant', null)).toBe('Home Assistant')
  })
  it('follows the device until the operator typed a name', () => {
    expect(nextAutoName('Home Assistant', false, 'Home Assistant', 'Pixel 7')).toBe(
      'Home Assistant — Pixel 7',
    )
    expect(nextAutoName('Home Assistant — Pixel 7', false, 'Home Assistant', 'iPad')).toBe(
      'Home Assistant — iPad',
    )
    expect(nextAutoName('My phone', true, 'Home Assistant', 'iPad')).toBeNull()
  })
  it('does not rewrite an already-correct name', () => {
    expect(nextAutoName('Home Assistant — iPad', false, 'Home Assistant', 'iPad')).toBeNull()
  })
})
