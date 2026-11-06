import { describe, expect, it } from 'vitest'
import { assertInstanceUnused, fieldUserFinder, InstanceInUseError } from '../instance-in-use.js'
import { BrokerInUseError, assertBrokerUnused } from '../broker-in-use.js'

const rows = [
  { id: 'a', name: 'A', formValues: { link: 'inst_1' } },
  { id: 'b', formValues: { link: ['inst_2', 'inst_1'] } },
  { id: 'c', formValues: { other: 'inst_1' } },
]

describe('instance in use', () => {
  it('fieldUserFinder reads a string field and a string list, over one or several fields', async () => {
    const finder = fieldUserFinder({
      kind: 'thing',
      field: ['link', 'other'],
      list: async () => rows,
    })
    expect((await finder.find('inst_1')).map((u) => u.id)).toEqual(['a', 'b', 'c'])
    const single = fieldUserFinder({ kind: 'thing', field: 'link', list: async () => rows })
    expect((await single.find('inst_2')).map((u) => u.id)).toEqual(['b'])
  })

  it('assertInstanceUnused names every user and passes when none', async () => {
    const finder = fieldUserFinder({ kind: 'thing', field: 'link', list: async () => rows })
    const err = await assertInstanceUnused('inst_1', [finder]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InstanceInUseError)
    if (!(err instanceof InstanceInUseError)) throw new Error('unreachable')
    expect(err.instanceId).toBe('inst_1')
    expect(err.users.map((u) => u.id)).toEqual(['a', 'b'])
    await expect(assertInstanceUnused('inst_9', [finder])).resolves.toBeUndefined()
  })

  it('keeps the broker names as the same primitive', async () => {
    const finder = fieldUserFinder({ kind: 'thing', field: 'link', list: async () => rows })
    await expect(assertBrokerUnused('inst_1', [finder])).rejects.toBeInstanceOf(BrokerInUseError)
    expect(new BrokerInUseError('x', [])).toBeInstanceOf(InstanceInUseError)
  })
})
