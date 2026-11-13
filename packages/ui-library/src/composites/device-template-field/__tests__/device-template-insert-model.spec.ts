import { describe, expect, it } from 'vitest'
import { tokenForInsert } from '../device-template-insert-model'

const caps = [{ cap: 'temperature-sensor', paths: ['temperature'] }]

describe('tokenForInsert', () => {
  it('omits unit when the field has none', () => {
    expect(
      tokenForInsert('stufa', { cap: 'climate', path: 'mode' }, caps, { withUnit: true }),
    ).toBe('{{ stufa.mode }}')
  })

  it('appends the runtime unit when With unit is on', () => {
    expect(
      tokenForInsert(
        'stufa',
        { cap: 'temperature-sensor', path: 'temperature' },
        caps,
        { withUnit: true, unit: '°C' },
      ),
    ).toBe("{{ stufa.temperature | unit('°C') }}")
  })

  it('omits the unit filter when With unit is off', () => {
    expect(
      tokenForInsert(
        'stufa',
        { cap: 'temperature-sensor', path: 'temperature' },
        caps,
        { withUnit: false, unit: '°C' },
      ),
    ).toBe('{{ stufa.temperature }}')
  })
})
