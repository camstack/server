/**
 * A create form whose discovered picker declares `pickManyOnCreate` ticks several values and makes
 * one record per value; a form without one is left as it is.
 */
import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { manyCreateItems, pickManyField, withMultiplePick } from '../pick-many'

const FORM: ConfigUISchema = {
  sections: [
    {
      id: 'echo',
      title: 'Echo',
      fields: [
        { type: 'text', key: 'brokerId', label: 'Account' },
        {
          type: 'select',
          key: 'echoId',
          label: 'Echo',
          options: [],
          discoverOptions: {
            kind: 'alexa-echo',
            dependsOn: ['brokerId'],
            pickManyOnCreate: true,
          },
        },
      ],
    },
  ],
}

describe('pick-many', () => {
  it('finds the declared picker and makes it hold several values', () => {
    expect(pickManyField(FORM)?.key).toBe('echoId')
    const field = withMultiplePick(FORM, 'echoId').sections[0]?.fields[1]
    expect(field?.type === 'select' ? field.discoverOptions?.multiple : undefined).toBe(true)
  })

  it('a form whose picker does not declare it has none', () => {
    const plain: ConfigUISchema = {
      sections: [
        {
          id: 's',
          title: 'S',
          fields: [
            {
              type: 'select',
              key: 'chat',
              label: 'Chat',
              options: [],
              discoverOptions: { kind: 'telegram', dependsOn: ['token'] },
            },
          ],
        },
      ],
    }
    expect(pickManyField(plain)).toBeNull()
    expect(pickManyField(null)).toBeNull()
  })

  it('several ticks: one record each, named after its candidate, every other value kept', () => {
    const items = manyCreateItems({
      key: 'echoId',
      picked: ['echo-k', 'echo-h', 'echo-gone'],
      labels: new Map([
        ['echo-k', 'Kitchen'],
        ['echo-h', 'Hall'],
      ]),
      typedName: 'Alexa',
      values: {
        brokerId: 'alexa_001',
        echoId: ['echo-k', 'echo-h', 'echo-gone'],
      },
    })
    expect(items).toEqual([
      { name: 'Kitchen', values: { brokerId: 'alexa_001', echoId: 'echo-k' } },
      { name: 'Hall', values: { brokerId: 'alexa_001', echoId: 'echo-h' } },
      {
        name: 'echo-gone',
        values: { brokerId: 'alexa_001', echoId: 'echo-gone' },
      },
    ])
  })

  it('one tick keeps the typed name', () => {
    const items = manyCreateItems({
      key: 'echoId',
      picked: ['echo-k'],
      labels: new Map([['echo-k', 'Kitchen']]),
      typedName: 'Doorbell speaker',
      values: { echoId: ['echo-k'] },
    })
    expect(items).toEqual([{ name: 'Doorbell speaker', values: { echoId: 'echo-k' } }])
  })
})
