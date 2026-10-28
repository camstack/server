import { describe, expect, it } from 'vitest'
import type { WireableCatalog } from '../../source-picker-model'
import { eventDeclarationCaps, eventDeviceCapEligible, eventSourceFromWireable } from '../event-fit'

const SWITCH_ONLY: WireableCatalog = {
  caps: [
    {
      cap: 'switch',
      fields: [
        { path: 'on', kind: 'boolean' },
        { path: 'lastChangedAt', kind: 'number' },
      ],
    },
  ],
}

const NO_SOURCE_BOOLEAN: WireableCatalog = {
  caps: [{ cap: 'power-meter', fields: [{ path: 'power', kind: 'number' }] }],
}

describe('eventDeclarationCaps', () => {
  it('lists binary and switch for doorbell and motion', () => {
    expect(eventDeclarationCaps('doorbell', 'pressed')).toEqual(['binary', 'switch'])
    expect(eventDeclarationCaps('motion', 'detected')).toEqual(['binary', 'switch'])
  })
})

describe('eventDeviceCapEligible', () => {
  it('accepts a device that carries a declared cap', () => {
    expect(eventDeviceCapEligible(['switch', 'power-meter'], ['binary', 'switch'])).toBe(true)
    expect(eventDeviceCapEligible(['motion'], ['binary', 'switch'])).toBe(false)
  })
})

describe('eventSourceFromWireable', () => {
  it('accepts a switch for span and pulse when transition time exists', () => {
    const span = eventSourceFromWireable(SWITCH_ONLY, 'motion', 'detected', 'span')
    expect(span).toMatchObject({ cap: 'switch', fieldPath: 'on' })
    const pulse = eventSourceFromWireable(SWITCH_ONLY, 'doorbell', 'pressed', 'pulse')
    expect(pulse?.changedAtField).toBe('lastChangedAt')
  })

  it('rejects wireables whose boolean is not on a declared source cap', () => {
    expect(eventSourceFromWireable(NO_SOURCE_BOOLEAN, 'motion', 'detected', 'span')).toBeNull()
  })
})
