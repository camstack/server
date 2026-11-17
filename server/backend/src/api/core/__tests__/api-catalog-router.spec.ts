/**
 * `apiCatalog.*` (planning#595): the API explorer's method list is read off the
 * LIVE router the hub serves — every procedure it holds, capability and core
 * alike — never a hand-written list.
 *
 * The router under test is built from the real procedure builders, so the tier
 * a method reports is the gate it actually runs behind.
 *
 * Disarm checks (each was run):
 *   - make `procedureTierOf` answer `protected` for everything → the admin
 *     method reports the wrong tier;
 *   - read the input schema with `io: 'output'` → the defaulted field turns
 *     required;
 *   - make `callableBy` answer `yes` for everything → the refused and the
 *     per-device cases fail.
 */
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import type { AuthenticatedAgent } from '../../trpc/trpc.context.js'
import {
  adminProcedure,
  protectedProcedure,
  publicProcedure,
  trpcRouter,
} from '../../trpc/trpc.middleware.js'
import type { ApiCatalogEntry, CredentialScope } from '@camstack/types'
import { callableBy, createApiCatalogRouter } from '../api-catalog.router.js'

const admin: AuthenticatedAgent = {
  id: 'u-admin',
  username: 'admin',
  isAdmin: true,
  permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
  isApiKey: false,
  interactive: true,
  userDelegated: true,
  scopes: ['*'],
}

const viewer: AuthenticatedAgent = {
  ...admin,
  id: 'u-viewer',
  username: 'viewer',
  isAdmin: false,
  permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
  scopes: [],
}

/** A small app: two core routers and one capability route (`addons.list`). */
function buildApp() {
  const holder: { procedures: Readonly<Record<string, unknown>> } = { procedures: {} }
  const app = trpcRouter({
    widgets: trpcRouter({
      ping: publicProcedure.query(() => 'pong'),
      list: protectedProcedure
        .input(z.object({ limit: z.number().int().default(10), label: z.string().optional() }))
        .query(() => []),
      wipe: adminProcedure.input(z.object({ id: z.string() })).mutation(() => true),
      watch: protectedProcedure.subscription(async function* () {
        yield 1
      }),
    }),
    addons: trpcRouter({
      list: adminProcedure.query(() => []),
    }),
    apiCatalog: createApiCatalogRouter(() => holder.procedures),
  })
  holder.procedures = app._def.procedures
  return app
}

describe('apiCatalog.list', () => {
  it('lists every procedure the router serves, with its kind and tier', async () => {
    const caller = buildApp().createCaller({ user: admin })
    const { methods } = await caller.apiCatalog.list()
    const byPath = new Map(methods.map((m) => [m.path, m]))

    expect(byPath.get('widgets.ping')).toMatchObject({
      router: 'widgets',
      method: 'ping',
      kind: 'query',
      tier: 'public',
      hasInput: false,
    })
    expect(byPath.get('widgets.list')).toMatchObject({
      kind: 'query',
      tier: 'protected',
      hasInput: true,
    })
    expect(byPath.get('widgets.wipe')).toMatchObject({ kind: 'mutation', tier: 'admin' })
    expect(byPath.get('widgets.watch')).toMatchObject({ kind: 'subscription' })
    // The catalogue lists itself too: it is part of what the hub serves.
    expect(byPath.get('apiCatalog.list')).toMatchObject({ kind: 'query', tier: 'admin' })
  })

  it('names the capability and its token scope for a cap route, nothing for a core route', async () => {
    const { methods } = await buildApp().createCaller({ user: admin }).apiCatalog.list()
    const cap = methods.find((m) => m.path === 'addons.list')
    const core = methods.find((m) => m.path === 'widgets.ping')
    expect(cap?.source).toBe('capability')
    expect(cap?.scope).toMatchObject({ capName: 'addons', capScope: 'system', access: 'view' })
    expect(core?.source).toBe('core')
    expect(core?.scope).toBeNull()
  })

  it('marks every method callable for a full admin', async () => {
    const { methods } = await buildApp().createCaller({ user: admin }).apiCatalog.list()
    expect(methods.every((m) => m.callable === 'yes')).toBe(true)
  })

  it('is sorted by path', async () => {
    const { methods } = await buildApp().createCaller({ user: admin }).apiCatalog.list()
    const paths = methods.map((m) => m.path)
    expect(paths).toEqual(paths.toSorted((a, b) => a.localeCompare(b)))
  })

  it('refuses a non-admin', async () => {
    await expect(buildApp().createCaller({ user: viewer }).apiCatalog.list()).rejects.toThrow()
  })
})

describe('apiCatalog.inputSchema', () => {
  it('answers the INPUT JSON schema of a method (a defaulted field is optional)', async () => {
    const caller = buildApp().createCaller({ user: admin })
    const out = await caller.apiCatalog.inputSchema({ path: 'widgets.list' })
    expect(out.hasInput).toBe(true)
    expect(out.error).toBeNull()
    expect(out.schema).toMatchObject({
      type: 'object',
      properties: { limit: { type: 'integer', default: 10 }, label: { type: 'string' } },
    })
    const required: unknown = out.schema === null ? undefined : out.schema['required']
    expect(required ?? []).toEqual([])
  })

  it('answers no schema for a method without input', async () => {
    const out = await buildApp()
      .createCaller({ user: admin })
      .apiCatalog.inputSchema({ path: 'widgets.ping' })
    expect(out).toEqual({ path: 'widgets.ping', hasInput: false, schema: null, error: null })
  })

  it('refuses a path the hub does not serve', async () => {
    await expect(
      buildApp().createCaller({ user: admin }).apiCatalog.inputSchema({ path: 'nope.nothing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

/** A non-interactive API token holding only `scopes`. */
function token(scopes: readonly CredentialScope[]): AuthenticatedAgent {
  return {
    ...viewer,
    id: 'token:t',
    username: 'token:t',
    isApiKey: true,
    interactive: false,
    scopes,
  }
}

/** A real device-scoped cap method (`switch` is per device), as the catalogue lists it. */
function capEntry(path: string, tier: ApiCatalogEntry['tier']): ApiCatalogEntry {
  const dot = path.lastIndexOf('.')
  return {
    path,
    router: path.slice(0, dot),
    method: path.slice(dot + 1),
    kind: 'query',
    tier,
    source: 'capability',
    scope: null,
    hasInput: true,
  }
}

describe('callableBy', () => {
  const getStatus = capEntry('switch.getStatus', 'protected')

  it('refuses a principal whose grants do not reach the method', () => {
    const other = token([{ type: 'capability', target: 'logs', access: ['view'] }])
    expect(callableBy(other, getStatus)).toBe('no')
  })

  it('a device grant at the method access depends on the device the input names', () => {
    const plug = token([{ type: 'device', selector: { kind: 'ids', ids: [7] }, access: ['view'] }])
    expect(callableBy(plug, getStatus)).toBe('per-device')
  })

  it('a device grant at another access is refused', () => {
    const viewOnly = token([
      { type: 'device', selector: { kind: 'ids', ids: [7] }, access: ['view'] },
    ])
    expect(callableBy(viewOnly, capEntry('switch.setState', 'protected'))).toBe('no')
  })

  it('a capability grant on the cap reaches it outright', () => {
    const cap = token([{ type: 'capability', target: 'switch', access: ['view'] }])
    expect(callableBy(cap, getStatus)).toBe('yes')
  })

  it('an admin-tier core method is refused to a non-admin', () => {
    const cap = token([{ type: 'capability', target: 'switch', access: ['view'] }])
    expect(callableBy(cap, { ...capEntry('addons.restart', 'admin'), source: 'core' })).toBe('no')
  })

  it('a public method is callable by anyone', () => {
    expect(callableBy(token([]), { ...getStatus, tier: 'public' })).toBe('yes')
  })
})
