/**
 * The hub retires a fixed integration row whose addon no longer declares
 * `integration-instances` — only with no live device on it (planning#580).
 */
import type { Integration } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type RetireDeviceRow,
  type RetireLogContext,
  retireUndeclaredFixedIntegrations,
} from '../retire-undeclared-fixed-integrations'

const row = (id: string, addonId: string, fixed = true): Integration => ({
  id,
  addonId,
  name: addonId,
  enabled: true,
  info: fixed ? { fixed: true } : {},
  createdAt: 0,
  updatedAt: 0,
})

const MANIFESTS: Readonly<Record<string, readonly string[]>> = {
  'camera-grid': ['camera-grid-layout', 'motion'],
  terminal: ['integration-instances', 'terminal-session'],
}

interface Run {
  readonly integrations: readonly Integration[]
  readonly devices: readonly RetireDeviceRow[] | null
}

async function run({ integrations, devices }: Run) {
  const retire = vi.fn(async (_integration: Integration) => undefined)
  const lines: { readonly message: string; readonly context?: RetireLogContext }[] = []
  const log = (message: string, context?: RetireLogContext): void => {
    lines.push({ message, ...(context !== undefined ? { context } : {}) })
  }
  const result = await retireUndeclaredFixedIntegrations({
    logger: { info: log, warn: log },
    listIntegrations: async () => integrations,
    declaredCapabilities: (addonId) => MANIFESTS[addonId],
    listDevices: async () => devices,
    retire,
  })
  return { result, retired: retire.mock.calls.map(([i]) => i.id), lines }
}

describe('retireUndeclaredFixedIntegrations', () => {
  it('keeps a fixed row its addon still declares, even with no device (Terminal)', async () => {
    const { retired } = await run({ integrations: [row('int_t', 'terminal')], devices: [] })
    expect(retired).toEqual([])
  })

  it('removes an undeclared fixed row with no live device (the empty Camera Grids row)', async () => {
    const { retired, result } = await run({
      integrations: [row('int_g', 'camera-grid'), row('int_t', 'terminal')],
      devices: [{ id: 7, addonId: 'terminal', integrationId: 'int_t' }],
    })
    expect(retired).toEqual(['int_g'])
    expect(result.retired).toEqual(['int_g'])
  })

  it('keeps an undeclared row a device still hangs off, and says why', async () => {
    const { retired, lines } = await run({
      integrations: [row('int_g', 'camera-grid')],
      devices: [{ id: 9, addonId: 'camera-grid', integrationId: 'int_g' }],
    })
    expect(retired).toEqual([])
    const why = lines.find((l) => l.message.includes('devices still hang off it'))
    expect(why?.context?.tags).toEqual({ integrationId: 'int_g', addonId: 'camera-grid' })
    expect(why?.context?.meta?.['devices']).toBe(1)
  })

  it('counts an un-tagged device of the same addon as hanging off the row', async () => {
    const { retired } = await run({
      integrations: [row('int_g', 'camera-grid')],
      devices: [{ id: 9, addonId: 'camera-grid' }],
    })
    expect(retired).toEqual([])
  })

  it('an unreadable device list retires nothing', async () => {
    const { retired } = await run({ integrations: [row('int_g', 'camera-grid')], devices: null })
    expect(retired).toEqual([])
  })

  it('never touches a non-fixed row or one whose addon is not installed', async () => {
    const { retired } = await run({
      integrations: [row('int_op', 'camera-grid', false), row('int_x', 'gone-addon')],
      devices: [],
    })
    expect(retired).toEqual([])
  })
})
