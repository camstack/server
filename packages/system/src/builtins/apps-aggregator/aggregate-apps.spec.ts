import { describe, it, expect, vi } from 'vitest'
import type { AppDeclaration, IAppSourceProvider } from '@dominevo/types'
import { aggregateApps } from './aggregate-apps.js'

function makeApp(id: string, over: Partial<AppDeclaration> = {}): AppDeclaration {
  return {
    id,
    label: { key: `apps.${id}`, fallback: id },
    icon: 'box',
    entry: { kind: 'native', route: `/${id}` },
    reach: { kind: 'hub' },
    adminOnly: false,
    nav: [],
    takesSharedSearch: false,
    settings: null,
    ...over,
  }
}

function source(id: string, apps: readonly AppDeclaration[]): IAppSourceProvider & { id: string } {
  return { id, listApps: () => Promise.resolve(apps) }
}

function failing(id: string): IAppSourceProvider & { id: string } {
  return { id, listApps: () => Promise.reject(new Error('boom')) }
}

function makeLogger() {
  return { warn: vi.fn() }
}

describe('aggregateApps', () => {
  it('merges two providers and stamps each app with its addonId', async () => {
    const logger = makeLogger()
    const out = await aggregateApps(
      [source('a', [makeApp('one')]), source('b', [makeApp('two')])],
      { isAdmin: true },
      logger,
    )
    expect(out.map((i) => [i.addonId, i.app.id])).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ])
  })

  it('hides adminOnly apps, admin-only nav items and out-of-scope apps from a non-admin', async () => {
    const logger = makeLogger()
    const admin = makeApp('admin', { adminOnly: true })
    const userOnly = makeApp('userOnly', { roles: ['user'] })
    const adminScoped = makeApp('adminScoped', { roles: ['admin'] })
    const mixed = makeApp('mixed', {
      nav: [
        {
          id: 's',
          label: null,
          items: [
            { id: 'pub', label: { key: 'k1', fallback: 'Pub' }, icon: 'x', path: '/p' },
            {
              id: 'adm',
              label: { key: 'k2', fallback: 'Adm' },
              icon: 'x',
              path: '/a',
              adminOnly: true,
            },
          ],
        },
      ],
    })
    const sources = [source('a', [admin, userOnly, adminScoped, mixed])]

    const asUser = await aggregateApps(sources, { isAdmin: false }, logger)
    expect(asUser.map((i) => i.app.id)).toEqual(['userOnly', 'mixed'])
    expect(asUser[1]?.app.nav[0]?.items.map((i) => i.id)).toEqual(['pub'])

    const asAdmin = await aggregateApps(sources, { isAdmin: true }, logger)
    expect(asAdmin.map((i) => i.app.id)).toEqual(['admin', 'adminScoped', 'mixed'])
    expect(asAdmin[2]?.app.nav[0]?.items.map((i) => i.id)).toEqual(['pub', 'adm'])
  })

  it('skips a failing provider, logs its reason and still serves the others', async () => {
    const logger = makeLogger()
    const out = await aggregateApps(
      [failing('bad'), source('good', [makeApp('ok')])],
      { isAdmin: true },
      logger,
    )
    expect(out.map((i) => i.app.id)).toEqual(['ok'])
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      'app-source provider failed',
      expect.objectContaining({
        meta: expect.objectContaining({ sourceId: 'bad', error: 'boom' }),
      }),
    )
  })

  it('orders by `order` then declaration order', async () => {
    const out = await aggregateApps(
      [
        source('a', [
          makeApp('late', { order: 20 }),
          makeApp('early', { order: 1 }),
          makeApp('none'),
        ]),
      ],
      { isAdmin: true },
      makeLogger(),
    )
    expect(out.map((i) => i.app.id)).toEqual(['early', 'late', 'none'])
  })

  it('lists the same app once when several nodes report it, keeping the first provider', async () => {
    const out = await aggregateApps(
      [
        { id: 'admin', listApps: () => Promise.resolve([makeApp('admin', { icon: 'hub' })]) },
        { id: 'admin', listApps: () => Promise.resolve([makeApp('admin', { icon: 'agent' })]) },
        source('other', [makeApp('admin')]),
      ],
      { isAdmin: true },
      makeLogger(),
    )
    expect(out.map((i) => [i.addonId, i.app.icon])).toEqual([
      ['admin', 'hub'],
      ['other', 'box'],
    ])
  })

  it('serves a failing provider from its last good snapshot', async () => {
    const lastGood = new Map<string, readonly AppDeclaration[]>()
    const logger = makeLogger()
    let fail = false
    const flaky: IAppSourceProvider & { id: string } = {
      id: 'flaky',
      listApps: () =>
        fail ? Promise.reject(new Error('race')) : Promise.resolve([makeApp('kept')]),
    }
    await aggregateApps([flaky], { isAdmin: true }, logger, lastGood)
    fail = true
    const out = await aggregateApps([flaky], { isAdmin: true }, logger, lastGood)
    expect(out.map((i) => i.app.id)).toEqual(['kept'])
    expect(logger.warn).toHaveBeenCalledWith(
      'app-source provider failed',
      expect.objectContaining({ meta: expect.objectContaining({ sourceId: 'flaky' }) }),
    )
    const gone = await aggregateApps([], { isAdmin: true }, logger, lastGood)
    expect(gone).toEqual([])
    expect(lastGood.size).toBe(0)
  })

  it('orders two apps without `order` as declared, never NaN', async () => {
    const out = await aggregateApps(
      [source('a', [makeApp('x'), makeApp('y', { order: 1 }), makeApp('z')])],
      { isAdmin: true },
      makeLogger(),
    )
    expect(out.map((i) => i.app.id)).toEqual(['y', 'x', 'z'])
  })
})
