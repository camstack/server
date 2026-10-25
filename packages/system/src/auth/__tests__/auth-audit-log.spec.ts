import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeStore } from '../../builtins/local-auth/__tests__/memory-settings-store.js'
import { AuthAuditLog } from '../auth-audit-log.js'

describe('AuthAuditLog', () => {
  it('records events and lists them newest first, per user', async () => {
    let now = 1
    const log = new AuthAuditLog(makeStore() as unknown as SettingsStoreClient, null, () => now)
    await log.record({
      action: 'second-factor-skipped',
      userId: 'u-1',
      ip: '192.168.1.4',
      detail: { method: 'password' },
    })
    now = 2
    await log.record({ action: 'admin-token-used', userId: 'u-2', detail: { path: '/trpc/x' } })
    const all = await log.list()
    expect(all.map((r) => r.action)).toEqual(['admin-token-used', 'second-factor-skipped'])
    expect(all[1]).toMatchObject({
      userId: 'u-1',
      ip: '192.168.1.4',
      detail: { method: 'password' },
    })
    expect((await log.list({ userId: 'u-1' })).length).toBe(1)
  })

  it('never throws when the store does — it logs instead', async () => {
    const error = vi.fn()
    const broken = {
      insert: {
        mutate: async () => {
          throw new Error('disk full')
        },
      },
    }
    const log = new AuthAuditLog(
      broken as unknown as SettingsStoreClient,
      {
        info: vi.fn(),
        error,
        warn: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(),
        withTags: vi.fn(),
      } as never,
    )
    await expect(log.record({ action: 'admin-token-created' })).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
  })
})
