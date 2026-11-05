import { describe, expect, it } from 'vitest'
import { assertBrokerUnused, BrokerInUseError } from '../broker-in-use.js'

describe('assertBrokerUnused', () => {
  it('passes when no finder names a user', async () => {
    await expect(
      assertBrokerUnused('alexa_002', [{ find: async () => [] }, { find: async () => [] }]),
    ).resolves.toBeUndefined()
  })

  it('throws a BrokerInUseError naming every user of every finder', async () => {
    const err = await assertBrokerUnused('alexa_002', [
      { find: async () => [{ kind: 'integration', id: 'int_0035', name: 'Home' }] },
      { find: async () => [{ kind: 'notification-target', id: 'alexa_002:echo1' }] },
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrokerInUseError)
    if (!(err instanceof BrokerInUseError)) throw new Error('unreachable')
    expect(err.brokerId).toBe('alexa_002')
    expect(err.users.map((u) => u.id)).toEqual(['int_0035', 'alexa_002:echo1'])
    expect(err.message).toContain('int_0035')
    expect(err.message).toContain('alexa_002:echo1')
  })
})
