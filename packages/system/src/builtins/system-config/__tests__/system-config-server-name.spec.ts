import type { AddonContext } from '@camstack/types'
import { SERVER_NAME_MAX_LENGTH } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { storeMayAnswer } from '../../../kernel/system-settings-policy.js'
import { SystemConfigAddon } from '../system-config.addon.js'

/**
 * The hub's human name (D861) is `server.name` in the `system-settings` store,
 * edited on System -> Settings. Nothing writes it by itself.
 */

function harness(initial: Record<string, Record<string, unknown>> = {}) {
  const sections = new Map<string, Record<string, unknown>>(Object.entries(initial))
  const setSection = vi.fn(async (name: string, patch: Record<string, unknown>) => {
    sections.set(name, { ...sections.get(name), ...patch })
  })
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
      setSection,
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
    },
  } as unknown as AddonContext
  return { ctx, sections, setSection }
}

async function started(initial: Record<string, Record<string, unknown>> = {}) {
  const h = harness(initial)
  const addon = new SystemConfigAddon()
  await addon.initialize(h.ctx)
  return { ...h, addon }
}

function fieldValue(form: unknown, key: string): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (node !== null && typeof node === 'object') {
      if (Reflect.get(node, 'key') === key && 'value' in node) return Reflect.get(node, 'value')
      for (const child of Object.values(node)) {
        const found = walk(child)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(form)
}

describe('System -> Settings: server name', () => {
  it('is never written by the addon itself (a seed never overwrites)', async () => {
    const { addon, setSection } = await started()
    await addon.getGlobalSettings()
    expect(setSection).not.toHaveBeenCalled()
    await addon.shutdown()
  })

  it('is drawn on the form as an editable field', async () => {
    const { addon } = await started()
    const form = JSON.stringify(await addon.getGlobalSettings())
    expect(form).toContain('"key":"name"')
    expect(form).toContain('Server name')
    await addon.shutdown()
  })

  it('saves a trimmed name into the server section and reads it back', async () => {
    const { addon, sections } = await started()
    await addon.updateGlobalSettings({ name: '  Casa Napoli  ' })
    expect(sections.get('server')).toEqual({ name: 'Casa Napoli' })
    expect(fieldValue(await addon.getGlobalSettings(), 'name')).toBe('Casa Napoli')
    await addon.shutdown()
  })

  it('refuses a name that is too long, with control characters, or blank-by-spaces on a set name', async () => {
    const { addon, sections } = await started()
    await expect(
      addon.updateGlobalSettings({ name: 'x'.repeat(SERVER_NAME_MAX_LENGTH + 1) }),
    ).rejects.toThrow(/at most 48/)
    await expect(addon.updateGlobalSettings({ name: 'Casa\u0007' })).rejects.toThrow(/control/)
    await expect(addon.updateGlobalSettings({ name: 'Casa\nNapoli' })).rejects.toThrow(/control/)
    expect(sections.get('server')).toBeUndefined()
    await addon.shutdown()
  })

  it('accepts exactly the longest name', async () => {
    const { addon, sections } = await started()
    const longest = 'y'.repeat(SERVER_NAME_MAX_LENGTH)
    await addon.updateGlobalSettings({ name: longest })
    expect(sections.get('server')).toEqual({ name: longest })
    await addon.shutdown()
  })

  it('an untouched empty field on an unnamed hub writes nothing', async () => {
    const { addon, setSection } = await started()
    await addon.updateGlobalSettings({ name: '', trustedProxies: [] })
    expect(setSection).not.toHaveBeenCalledWith('server', expect.anything())
    await addon.shutdown()
  })

  it('clearing a set name stores an empty value, which readers treat as unset', async () => {
    const { addon, sections } = await started({ server: { name: 'Casa' } })
    await addon.updateGlobalSettings({ name: '   ' })
    expect(sections.get('server')).toEqual({ name: '' })
    await addon.shutdown()
  })

  it('still ignores the read-only connection keys of the server section', async () => {
    const { addon, sections } = await started()
    await addon.updateGlobalSettings({ port: 1234, host: 'x', dataPath: '/y', name: 'Casa' })
    expect(sections.get('server')).toEqual({ name: 'Casa' })
    await addon.shutdown()
  })

  it('the settings store may answer it, and still not the other server keys', () => {
    expect(storeMayAnswer('server.name')).toBe(true)
    expect(storeMayAnswer('server.port')).toBe(false)
  })
})
