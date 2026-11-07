import type { AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { InvalidCorsOriginError } from '../../../auth/origin.js'
import { isPreloadedSystemKey, storeMayAnswer } from '../../../kernel/system-settings-policy.js'
import { bootstrapFormActions } from '../bootstrap-form-actions.js'
import { SystemConfigAddon } from '../system-config.addon.js'

/**
 * The network-list auth settings (trusted proxies; trusted networks) are
 * edited on System → Authentication. A save naming something that is not an
 * address or CIDR range is refused whole.
 */

function harness() {
  const sections = new Map<string, Record<string, unknown>>()
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: 'system-config',
    logger,
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    settings: {
      getSection: async (name: string) => ({ ...sections.get(name) }),
      setSection: async (name: string, patch: Record<string, unknown>) => {
        sections.set(name, { ...sections.get(name), ...patch })
      },
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
  } as unknown as AddonContext
  return { ctx, sections }
}

async function started() {
  const h = harness()
  const addon = new SystemConfigAddon()
  await addon.initialize(h.ctx)
  return { ...h, addon }
}

describe('System → Authentication: trusted proxies', () => {
  it('saves a list of addresses / CIDRs into the auth section', async () => {
    const { addon, sections } = await started()
    await addon.saveBootstrapForm({
      trustedProxies: ['192.168.1.2', '10.0.0.0/24'],
    })
    expect(sections.get('auth')).toEqual({
      trustedProxies: ['192.168.1.2', '10.0.0.0/24'],
    })
    await addon.shutdown()
  })

  it('refuses the whole save when an entry is not a network', async () => {
    const { addon, sections } = await started()
    await expect(
      addon.saveBootstrapForm({ trustedProxies: ['192.168.1.2', 'my-proxy'] }),
    ).rejects.toThrow(/my-proxy/)
    expect(sections.get('auth')).toBeUndefined()
    await addon.shutdown()
  })

  it('is drawn on the form', async () => {
    const { addon } = await started()
    expect(JSON.stringify(await addon.getBootstrapForm())).toContain('trustedProxies')
    await addon.shutdown()
  })

  it('the settings store may answer it (it is read by the hub, not only by the form)', () => {
    expect(storeMayAnswer('auth.trustedProxies')).toBe(true)
    expect(storeMayAnswer('auth.jwtSecret')).toBe(false)
  })
})

describe('System → Authentication: session and access-token lifetimes', () => {
  it('saves both lifetimes into the auth section the hub reads', async () => {
    const { addon, sections } = await started()
    await addon.saveBootstrapForm({
      tokenExpiry: '30d',
      accessTokenExpiry: '1h',
    })
    expect(sections.get('auth')).toEqual({
      tokenExpiry: '30d',
      accessTokenExpiry: '1h',
    })
    expect(storeMayAnswer('auth.accessTokenExpiry')).toBe(true)
    await addon.shutdown()
  })
})

describe('System → Authentication: trusted networks (opt-in second-factor skip)', () => {
  it('is off by default and warns, loudly, on the form', async () => {
    const { addon, sections } = await started()
    expect(sections.get('auth')).toBeUndefined()
    const form = JSON.stringify(await addon.getBootstrapForm())
    expect(form).toContain('trustedNetworks')
    expect(form).toContain('"variant":"danger"')
    expect(form).toMatch(/never skip it/)
    await addon.shutdown()
  })

  it('refuses an entry that is not a network', async () => {
    const { addon } = await started()
    await expect(addon.saveBootstrapForm({ trustedNetworks: ['home'] })).rejects.toThrow(/home/)
    await addon.saveBootstrapForm({ trustedNetworks: ['192.168.1.0/24'] })
    expect(storeMayAnswer('auth.trustedNetworks')).toBe(true)
    await addon.shutdown()
  })
})

describe('System → Authentication: allowed browser origins (D707)', () => {
  it('saves normalised-valid origins into the auth section, the store may answer and preloads it', async () => {
    const { addon, sections } = await started()
    await addon.saveBootstrapForm({
      corsOrigins: ['https://viewer.example', 'http://localhost:8081'],
    })
    expect(sections.get('auth')).toEqual({
      corsOrigins: ['https://viewer.example', 'http://localhost:8081'],
    })
    expect(storeMayAnswer('auth.corsOrigins')).toBe(true)
    expect(isPreloadedSystemKey('auth.corsOrigins')).toBe(true)
    expect(JSON.stringify(await addon.getBootstrapForm())).toContain('"key":"corsOrigins"')
    await addon.shutdown()
  })

  it('refuses a save with an entry that is not an origin, with a typed error, writing nothing', async () => {
    const { addon, sections } = await started()
    const err = await addon
      .saveBootstrapForm({
        corsOrigins: ['https://ok.example', 'https://x.example/path', 'ftp://h'],
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidCorsOriginError)
    expect(err instanceof InvalidCorsOriginError && err.invalid).toEqual([
      'https://x.example/path',
      'ftp://h',
    ])
    expect(sections.get('auth')).toBeUndefined()
    await addon.shutdown()
  })

  it('warns on the form about plain-http origins', async () => {
    const { addon } = await started()
    expect(JSON.stringify(await addon.getBootstrapForm())).toMatch(/http:\/\/ origin other than/)
    await addon.shutdown()
  })
})

describe('System → Authentication: the bootstrap form actions', () => {
  it('declares the pair: the read open to a signed-in caller, the save admin-only', () => {
    expect(bootstrapFormActions['getBootstrapForm']?.auth).toBe('protected')
    expect(bootstrapFormActions['saveBootstrapForm']?.auth).toBe('admin')
    expect(bootstrapFormActions['saveBootstrapForm']?.kind).toBe('mutation')
  })

  it('serves the form and the save through the registered handlers', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    const init = await addon.initialize(h.ctx)
    const handlers = init === undefined ? undefined : init.actionHandlers
    const save = handlers?.['saveBootstrapForm']
    const read = handlers?.['getBootstrapForm']
    if (save === undefined || read === undefined)
      throw new Error('the bootstrap handlers are not registered')
    expect(Object.keys(init?.customActions ?? {})).toEqual(
      expect.arrayContaining(['getBootstrapForm', 'saveBootstrapForm', 'mintAgentUiUnlockTicket']),
    )
    await expect(save({ patch: { tokenExpiry: '7d' } })).resolves.toEqual({
      success: true,
    })
    expect(h.sections.get('auth')).toEqual({ tokenExpiry: '7d' })
    expect(JSON.stringify(await read({}))).toContain('"value":"7d"')
    await addon.shutdown()
  })

  it('a section that cannot be read fails the form instead of showing defaults (D675)', async () => {
    const h = harness()
    const addon = new SystemConfigAddon()
    await addon.initialize(h.ctx)
    const real = h.ctx.settings!.getSection
    h.ctx.settings!.getSection = async (name: string) => {
      if (name === 'auth') throw new Error('store down')
      return real(name)
    }
    await expect(addon.getBootstrapForm()).rejects.toThrow(/store down/)
    await addon.shutdown()
  })
})
