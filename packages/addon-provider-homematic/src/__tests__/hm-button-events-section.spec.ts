import { describe, expect, it } from 'vitest'
import { buttonEventsSection } from '../devices/hm-button-events-section.js'

const KEY1 = {
  address: '00315F298E5093:1',
  name: null,
  index: '1',
  central: false,
  links: [
    {
      receiver: '00315F298E5093:4',
      receiverName: 'Luce bagno',
      receiverDeviceName: 'Pulsante bagno camerette',
    },
  ],
}

describe('buttonEventsSection', () => {
  it('shows each key with its central link, its direct links and a confirmed toggle', () => {
    const [section] = buttonEventsSection('hm_1', [
      KEY1,
      { ...KEY1, address: '00315F298E5093:2', index: '2', central: true, links: [] },
    ])
    if (section === undefined) throw new Error('no section')
    const table = section.fields.find((field) => field.type === 'object-array')
    expect(table?.type === 'object-array' ? table.value : null).toEqual([
      { key: 'Key 1', central: 'warn', links: 'Luce bagno (00315F298E5093:4)' },
      { key: 'Key 2', central: 'ok', links: '—' },
    ])
    const buttons = section.fields.flatMap((field) =>
      field.type === 'addon-action-button' ? [field] : [],
    )
    expect(buttons.map((button) => button.paramsStatic)).toEqual([
      { integrationId: 'hm_1', address: '00315F298E5093:1', enabled: true, confirmed: true },
      { integrationId: 'hm_1', address: '00315F298E5093:2', enabled: false, confirmed: true },
    ])
    expect(buttons.every((button) => typeof button.confirmMessage === 'string')).toBe(true)
    expect(section.fields.some((field) => field.type === 'info')).toBe(true)
  })

  it('offers no toggle for a key whose read failed, and shows it unknown', () => {
    const [section] = buttonEventsSection('hm_1', [{ ...KEY1, central: null, links: [] }])
    expect(section?.fields.some((field) => field.type === 'addon-action-button')).toBe(false)
    const table = section?.fields.find((field) => field.type === 'object-array')
    expect(table?.type === 'object-array' ? table.value[0]?.['central'] : null).toBe('unknown')
  })

  it('draws nothing without an integration or keys', () => {
    expect(buttonEventsSection(undefined, [KEY1])).toEqual([])
    expect(buttonEventsSection('hm_1', [])).toEqual([])
  })
})
