import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { nextPausedState, pushAfterResume, pushStatusOf } from '../push-state.js'
import type { LwaTokenEntry } from '../types.js'

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
  withTags: () => logger,
} as unknown as IScopedLogger

const RESULT = { deviceCount: 2, endpointCount: 3, accountCount: 1, failures: [] }

function token(userId: string, push?: LwaTokenEntry['push']): LwaTokenEntry {
  return { userId, accessToken: 'a', expiresAt: 1, receivedAt: 0, ...(push ? { push } : {}) }
}

describe('pushStatusOf', () => {
  const accounts = [{ userId: 'a' }, { userId: 'b' }]
  it('is ok with no linked account', () => {
    expect(pushStatusOf([], [])).toBe('ok')
  })
  it('is ok when every account holds an unpaused grant', () => {
    expect(pushStatusOf(accounts, [token('a'), token('b', { state: 'ok' })])).toBe('ok')
  })
  it('is paused when one account is paused', () => {
    const paused = nextPausedState(undefined, 'grant-revoked', 0)
    expect(pushStatusOf(accounts, [token('a'), token('b', paused)])).toBe('paused')
  })
  it('is paused when a linked account holds no grant at all', () => {
    expect(pushStatusOf(accounts, [token('a')])).toBe('paused')
  })
})

describe('pushAfterResume', () => {
  it('pushes everything to the account, then refreshes visibility', async () => {
    const order: string[] = []
    await pushAfterResume('a', {
      pushAllToAccount: async (id) => {
        order.push(`push:${id}`)
        return RESULT
      },
      refreshVisibility: async () => {
        order.push('visibility')
      },
      logger,
    })
    expect(order).toEqual(['push:a', 'visibility'])
  })
  it('a failed push is logged and never throws', async () => {
    const warn = vi.fn()
    await expect(
      pushAfterResume('a', {
        pushAllToAccount: async () => {
          throw new Error('boom')
        },
        refreshVisibility: async () => {},
        logger: { ...logger, warn } as unknown as IScopedLogger,
      }),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
