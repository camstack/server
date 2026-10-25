import type { AddonContext } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { storeMayAnswer } from '../../../kernel/system-settings-policy.js'
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
    await addon.updateGlobalSettings({ trustedProxies: ['192.168.1.2', '10.0.0.0/24'] })
    expect(sections.get('auth')).toEqual({ trustedProxies: ['192.168.1.2', '10.0.0.0/24'] })
    await addon.shutdown()
  })

  it('refuses the whole save when an entry is not a network', async () => {
    const { addon, sections } = await started()
    await expect(
      addon.updateGlobalSettings({ trustedProxies: ['192.168.1.2', 'my-proxy'] }),
    ).rejects.toThrow(/my-proxy/)
    expect(sections.get('auth')).toBeUndefined()
    await addon.shutdown()
  })

  it('is drawn on the form', async () => {
    const { addon } = await started()
    expect(JSON.stringify(await addon.getGlobalSettings())).toContain('trustedProxies')
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
    await addon.updateGlobalSettings({ tokenExpiry: '30d', accessTokenExpiry: '1h' })
    expect(sections.get('auth')).toEqual({ tokenExpiry: '30d', accessTokenExpiry: '1h' })
    expect(storeMayAnswer('auth.accessTokenExpiry')).toBe(true)
    await addon.shutdown()
  })
})

describe('System → Authentication: trusted networks (opt-in second-factor skip)', () => {
  it('is off by default and warns, loudly, on the form', async () => {
    const { addon, sections } = await started()
    expect(sections.get('auth')).toBeUndefined()
    const form = JSON.stringify(await addon.getGlobalSettings())
    expect(form).toContain('trustedNetworks')
    expect(form).toContain('"variant":"danger"')
    expect(form).toMatch(/never skip it/)
    await addon.shutdown()
  })

  it('refuses an entry that is not a network', async () => {
    const { addon } = await started()
    await expect(addon.updateGlobalSettings({ trustedNetworks: ['home'] })).rejects.toThrow(/home/)
    await addon.updateGlobalSettings({ trustedNetworks: ['192.168.1.0/24'] })
    expect(storeMayAnswer('auth.trustedNetworks')).toBe(true)
    await addon.shutdown()
  })
})
