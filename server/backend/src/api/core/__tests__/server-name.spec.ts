import { staticJwtSigningKey } from '@camstack/system'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AuthService } from '../../../core/auth/auth.service.js'
import { createAuthRouter } from '../auth.router.js'
import { ServerNameReader, serverNameReaderFor } from '../server-name.js'

/**
 * D861 - the hub's human name. Stored as `system-settings` / `server.name`,
 * never written by a reader; unset (or damaged) reads as the machine hostname
 * without its domain, flagged `isDefault: true`.
 */

const readerWith = (stored: unknown, hostname = 'nas.lan.example') =>
  new ServerNameReader({
    store: { get: async () => stored },
    hostname: () => hostname,
  })

describe('ServerNameReader', () => {
  it('unset reads as the short hostname, flagged as the default', async () => {
    expect(await readerWith(undefined).read()).toEqual({ name: 'nas', isDefault: true })
    expect(await readerWith(null).read()).toEqual({ name: 'nas', isDefault: true })
  })

  it('a stored name wins and is not the default', async () => {
    expect(await readerWith('Casa Napoli').read()).toEqual({
      name: 'Casa Napoli',
      isDefault: false,
    })
  })

  it('a cleared (empty) or damaged row reads as unset', async () => {
    expect(await readerWith('').read()).toMatchObject({ isDefault: true })
    expect(await readerWith('   ').read()).toMatchObject({ isDefault: true })
    expect(await readerWith('x'.repeat(49)).read()).toMatchObject({ isDefault: true })
    expect(await readerWith('bad\u0007name').read()).toMatchObject({ isDefault: true })
    expect(await readerWith(42).read()).toMatchObject({ isDefault: true })
  })

  it('reads the one row, server.name, in system-settings', async () => {
    const get = vi.fn(async () => 'Casa')
    await new ServerNameReader({ store: { get } }).read()
    expect(get).toHaveBeenCalledWith({ collection: 'system-settings', key: 'server.name' })
  })

  it('a failed read answers the default but says so', async () => {
    const warn = vi.fn()
    const reader = new ServerNameReader({
      store: {
        get: async () => {
          throw new Error('store down')
        },
      },
      hostname: () => 'nas',
      logger: { warn } as never,
    })
    expect(await reader.read()).toEqual({ name: 'nas', isDefault: true })
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('without a settings-store cap it answers the default instead of throwing', async () => {
    const reader = serverNameReaderFor({ getSingleton: () => null } as never)
    expect(await reader.read()).toMatchObject({ isDefault: true })
  })

  it('save -> read back through the settings-store cap', async () => {
    const rows = new Map<string, unknown>()
    const registry = {
      getSingleton: () => ({
        get: async (i: { collection: string; key: string }) => rows.get(`${i.collection}/${i.key}`),
      }),
    }
    const reader = serverNameReaderFor(registry as never)
    expect((await reader.read()).isDefault).toBe(true)
    rows.set('system-settings/server.name', 'Casa Napoli')
    expect(await reader.read()).toEqual({ name: 'Casa Napoli', isDefault: false })
  })
})

function makeAuth(): AuthService {
  const store: Record<string, unknown> = {}
  return new AuthService(
    {
      get<T>(path: string): T {
        return store[path] as T
      },
      update(): void {},
    } as never,
    undefined,
    staticJwtSigningKey('server-name-secret'),
  )
}

describe('auth.getServerName (public, pre-login)', () => {
  const registryWith = (name: unknown) => ({
    getSingleton: () => ({ get: async () => name }),
    getCollection: () => [],
    getCollectionEntries: () => [],
    isProviderDisabled: () => false,
  })
  const anon = (name: unknown) =>
    createAuthRouter(makeAuth(), registryWith(name) as never).createCaller({ user: null } as never)

  it('answers the chosen name to a signed-out caller', async () => {
    expect(await anon('Casa Napoli').getServerName()).toEqual({
      name: 'Casa Napoli',
      isDefault: false,
    })
  })

  it('answers the hostname default, flagged, when the hub was never named', async () => {
    const result = await anon(undefined).getServerName()
    expect(result.isDefault).toBe(true)
    expect(result.name).not.toContain('.')
  })

  it('exposes nothing else: exactly name and isDefault', async () => {
    expect(Object.keys(await anon('Casa').getServerName()).sort()).toEqual(['isDefault', 'name'])
  })

  it('listLoginMethods stays a bare array that the OLD schema still parses (installed viewers)', async () => {
    const OldShape = z.array(z.object({ kind: z.string(), id: z.string() }).passthrough())
    const result = await anon('Casa').listLoginMethods()
    expect(Array.isArray(result)).toBe(true)
    expect(OldShape.safeParse(result).success).toBe(true)
  })
})
