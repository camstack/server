/**
 * The settings form still names an instance's switch and address role as `exportTo:<id>` and
 * `mediaRole:<id>`; a write lands in that broker's `ha-export-links` record and nowhere else.
 * Disarm: route the keys to `super.updateGlobalSettingsAsOperator` (the old store) and "writes
 * the record" fails; drop the broker check and "refuses an unknown broker" fails.
 */
import {
  ExportInstanceUnknownError,
  type IScopedLogger,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ExportLinks, haExportLinksKind } from '../link-records.js'
import { HaExportAddon } from '../ha-export.addon.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

async function harness() {
  const addon = new HaExportAddon()
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-links': haExportLinksKind })
  const handle = memory.records.kind(haExportLinksKind)
  const stored: Record<string, unknown>[] = []
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, '_config', { knownBrokers: [{ id: 'ha_001', name: 'Home' }] })
  Reflect.set(addon, 'linkBook', await ExportLinks.load(handle))
  Reflect.set(addon, 'onConfigChanged', async () => undefined)
  Reflect.set(addon, 'updateGlobalSettings', async (patch: Record<string, unknown>) => {
    stored.push(patch)
  })
  return {
    write: (patch: Record<string, unknown>) => addon.updateGlobalSettingsAsOperator(patch),
    record: async (id: string) => (await handle.get(id))?.data ?? null,
    stored,
  }
}

describe('the settings form writes the export links', () => {
  it('writes the switch and the role of one instance into its record', async () => {
    const h = await harness()
    await h.write({ 'exportTo:ha_001': true, 'mediaRole:ha_001': 'publicEndpoint' })
    expect(await h.record('ha_001')).toEqual({
      name: 'Home',
      exportTo: true,
      mediaRole: 'publicEndpoint',
      devices: [],
    })
    expect(h.stored).toEqual([])
  })

  it('refuses an instance the addon does not know, writing nothing', async () => {
    const h = await harness()
    await expect(h.write({ 'exportTo:ha_999': true })).rejects.toBeInstanceOf(
      ExportInstanceUnknownError,
    )
    expect(await h.record('ha_999')).toBeNull()
  })

  it('refuses a value that is not a switch or a known role', async () => {
    const h = await harness()
    await expect(h.write({ 'exportTo:ha_001': 'yes' })).rejects.toThrow(/true or false/)
    await expect(h.write({ 'mediaRole:ha_001': 'https://typed-url' })).rejects.toThrow(
      /address role/,
    )
    expect(await h.record('ha_001')).toBeNull()
  })
})
