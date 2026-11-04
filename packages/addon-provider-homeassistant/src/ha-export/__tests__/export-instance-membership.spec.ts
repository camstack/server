/**
 * A `device-export` write changes ONE target's membership - the named instance - and a target
 * the addon does not hold is refused by name; the device-panel key `haExport:<deviceId>:<targetId>`
 * names the target the same way.
 *
 * Disarm: make `setTargetMembership` write every enabled target (the old "everywhere" path) -
 * "writes only the named target" fails; drop the `targetScope` check - "unknown target" fails.
 */
import {
  ExportInstanceUnknownError,
  type IScopedLogger,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import type { ExportMembership } from '../membership.js'
import { ExportTargets, haExportTargetsKind, newTargetBody } from '../target-records.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

interface Harness {
  readonly write: (instanceId: string, deviceId: string, exposed: boolean) => Promise<void>
  readonly scope: (instanceId: string | undefined) => readonly string[]
  /** What the records hold now, by target. */
  readonly stored: () => Promise<Record<string, readonly string[]>>
  readonly reconciles: string[]
}

const TARGETS = ['hae_001', 'hae_002']

async function harness(membership: ExportMembership): Promise<Harness> {
  const addon = new HaExportAddon()
  const reconciles: string[] = []
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-targets': haExportTargetsKind })
  const handle = memory.records.kind(haExportTargetsKind)
  for (const id of TARGETS) {
    await handle.put({
      id,
      data: { ...newTargetBody(id), devices: membership[id] ?? [] },
    })
  }
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, 'enabled', TARGETS)
  Reflect.set(addon, 'targetBook', await ExportTargets.load(handle))
  Reflect.set(addon, 'reconcile', async (reason: string) => {
    reconciles.push(reason)
  })
  const write: unknown = Reflect.get(addon, 'setTargetMembership')
  const scope: unknown = Reflect.get(addon, 'targetScope')
  if (typeof write !== 'function' || typeof scope !== 'function') throw new Error('no seam')
  return {
    write: (instanceId, deviceId, exposed) => write.call(addon, instanceId, deviceId, exposed),
    scope: (instanceId) => scope.call(addon, instanceId),
    stored: async () => {
      const page = await handle.query({ limit: 100 })
      return Object.fromEntries(page.records.map((row) => [row.id, row.data.devices]))
    },
    reconciles,
  }
}

describe('a device-export write targets one target', () => {
  it('writes only the named target; the other target is unchanged', async () => {
    const h = await harness({ hae_001: ['10'], hae_002: ['20'] })
    await h.write('hae_001', '11', true)
    const stored = await h.stored()
    expect(stored['hae_001']).toEqual(['10', '11'])
    expect(stored['hae_002']).toEqual(['20'])
    expect(h.reconciles).toEqual(['expose'])
  })

  it('unexposes from the named target only', async () => {
    const h = await harness({ hae_001: ['10'], hae_002: ['10'] })
    await h.write('hae_002', '10', false)
    const stored = await h.stored()
    expect(stored['hae_001']).toEqual(['10'])
    expect(stored['hae_002'] ?? []).toEqual([])
  })

  it('refuses a target it does not hold, writing nothing', async () => {
    const h = await harness({ hae_001: ['10'] })
    await expect(h.write('hae_999', '11', true)).rejects.toBeInstanceOf(ExportInstanceUnknownError)
    expect((await h.stored())['hae_001']).toEqual(['10'])
    expect((await h.stored())['hae_999']).toBeUndefined()
  })
})

describe('a device-export read scope', () => {
  it('is every enabled target when absent, the named one when present, a refusal when unknown', async () => {
    const h = await harness({})
    expect(h.scope(undefined)).toEqual(['hae_001', 'hae_002'])
    expect(h.scope('hae_002')).toEqual(['hae_002'])
    expect(() => h.scope('hae_999')).toThrow(ExportInstanceUnknownError)
  })
})
