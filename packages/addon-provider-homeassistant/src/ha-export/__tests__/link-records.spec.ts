/**
 * The `ha-export-links` records are the only home of an instance's export switch, media role and
 * exported devices. Disarm: let `isEnabled` answer from anything but the record (a stale copy, a
 * default of true) and "reads the switch from the record" or "off until switched" fails; let
 * `prune` ignore the known list and "keeps the instances the hub still knows" fails.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  defaultLinks,
  ExportLinks,
  exportToFormKey,
  haExportLinksKind,
  linkFormOverlay,
  mediaRoleFormKey,
  parseLinkFormKey,
} from '../link-records.js'

async function open() {
  const memory = makeInMemoryRecords('homeassistant-export')
  await memory.records.declare({ 'ha-export-links': haExportLinksKind })
  const handle = memory.records.kind(haExportLinksKind)
  return { handle, load: () => ExportLinks.load(handle) }
}

describe('ExportLinks', () => {
  it('is off, public-endpoint and empty for an instance with no record', async () => {
    const links = await (await open()).load()
    expect(links.isEnabled('ha_001')).toBe(false)
    expect(links.mediaRole('ha_001')).toBe('publicEndpoint')
    expect(links.membership()).toEqual({})
    expect(defaultLinks('Home').mediaRole).toBe('publicEndpoint')
  })

  it('reads the switch, the role and the devices from the record, per instance', async () => {
    const { handle, load } = await open()
    await handle.put({
      id: 'ha_001',
      data: {
        name: 'Home',
        exportTo: true,
        mediaRole: 'publicEndpoint',
        devices: ['7'],
      },
    })
    await handle.put({ id: 'ha_002', data: defaultLinks('Cabin') })
    const links = await load()
    expect(links.isEnabled('ha_001')).toBe(true)
    expect(links.isEnabled('ha_002')).toBe(false)
    expect(links.mediaRole('ha_001')).toBe('publicEndpoint')
    expect(links.membership()).toEqual({ ha_001: ['7'] })
  })

  it('persists a flag change into the record and keeps the devices', async () => {
    const { handle, load } = await open()
    await handle.put({
      id: 'ha_001',
      data: { ...defaultLinks('Home'), devices: ['7'] },
    })
    const links = await load()
    await links.setFlags('ha_001', 'Home', { exportTo: true })
    expect((await handle.get('ha_001'))?.data).toMatchObject({
      exportTo: true,
      devices: ['7'],
    })
    expect(links.isEnabled('ha_001')).toBe(true)
  })

  it('writes nothing when a flag is set to the value it already has', async () => {
    const { handle, load } = await open()
    await handle.put({ id: 'ha_001', data: defaultLinks('Home') })
    const before = await handle.get('ha_001')
    await (await load()).setFlags('ha_001', 'Home', { exportTo: false })
    expect(await handle.get('ha_001')).toEqual(before)
  })

  it('keeps the membership identity until a device list changes', async () => {
    const { load } = await open()
    const links = await load()
    const first = links.membership()
    await links.setFlags('ha_001', 'Home', { exportTo: true })
    expect(links.membership()).toBe(first)
    await links.setMembership({ ha_001: ['7'] }, () => 'Home')
    expect(links.membership()).toEqual({ ha_001: ['7'] })
    expect(links.membership()).not.toBe(first)
  })

  it('keeps the instances the hub still knows and forgets the others', async () => {
    const { handle, load } = await open()
    await handle.put({ id: 'ha_001', data: defaultLinks('Home') })
    await handle.put({
      id: 'ha_gone',
      data: { ...defaultLinks('Gone'), devices: ['9'] },
    })
    const links = await load()
    expect(await links.prune(['ha_001'])).toEqual(['ha_gone'])
    expect(await handle.get('ha_gone')).toBeNull()
    expect(await handle.get('ha_001')).not.toBeNull()
    expect(links.membership()).toEqual({})
  })
})

describe('the form keys', () => {
  it('names an instance fact and routes it back', () => {
    expect(parseLinkFormKey(exportToFormKey('ha_001'))).toEqual({
      flag: 'exportTo',
      brokerId: 'ha_001',
    })
    expect(parseLinkFormKey(mediaRoleFormKey('ha_001'))).toEqual({
      flag: 'mediaRole',
      brokerId: 'ha_001',
    })
    expect(parseLinkFormKey('reconcileIntervalSec')).toBeNull()
    expect(parseLinkFormKey('exportTo:')).toBeNull()
  })

  it('overlays the record values on the form', async () => {
    const { handle, load } = await open()
    await handle.put({
      id: 'ha_001',
      data: {
        name: 'Home',
        exportTo: true,
        mediaRole: 'publicEndpoint',
        devices: [],
      },
    })
    expect(linkFormOverlay(await load())).toEqual({
      'exportTo:ha_001': true,
      'mediaRole:ha_001': 'publicEndpoint',
    })
  })
})
