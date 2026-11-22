import type { CapLinkView, Composition, CustomizeCapLink } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  capLinkCellState,
  capLinkOfferedOn,
  storedCapLink,
  withCapLink,
  withoutCapLink,
} from '../cap-link-edit'

const HOST = { addonId: 'ha', stableId: 'dryer' }
const SOURCE = { addonId: 'ha', stableId: 'plug' }
const OTHER = { addonId: 'ha', stableId: 'plug-2' }
const LINK: CustomizeCapLink = {
  id: 'meter-device',
  sourceCap: 'power-meter',
  mode: 'project',
  apply: 'add',
  deviceTypes: [DeviceType.Switch],
}
const OFFERED = { cap: 'power-meter', link: LINK }

describe('a whole-capability link in the customization', () => {
  it('stores ONE capLink feature, never a field per value', () => {
    const next = withCapLink(null, HOST, OFFERED, SOURCE)
    expect(next.target).toEqual({ kind: 'existing', device: HOST })
    expect(next.features).toEqual([
      { kind: 'capLink', cap: 'power-meter', linkId: 'meter-device', source: SOURCE },
    ])
  })

  it('a second pick replaces the source and keeps every other feature', () => {
    const fields: Composition = {
      target: { kind: 'existing', device: HOST },
      features: [{ kind: 'fields', cap: 'running-state', fields: {} }],
    }
    const once = withCapLink(fields, HOST, OFFERED, SOURCE)
    const twice = withCapLink(once, HOST, OFFERED, OTHER)
    expect(twice.features).toHaveLength(2)
    expect(storedCapLink(twice, 'power-meter', 'meter-device')?.source).toEqual(OTHER)
  })

  it('clearing the last feature of an existing device deletes the block', () => {
    const once = withCapLink(null, HOST, OFFERED, SOURCE)
    expect(withoutCapLink(once, OFFERED)).toBeNull()
  })

  it('a link is offered only on the device types it names', () => {
    expect(capLinkOfferedOn(LINK, DeviceType.Switch)).toBe(true)
    expect(capLinkOfferedOn(LINK, DeviceType.Camera)).toBe(false)
    expect(capLinkOfferedOn({ ...LINK, deviceTypes: undefined }, DeviceType.Switch)).toBe(false)
  })

  it('the cell state follows the server read, else what is stored', () => {
    const stored = storedCapLink(
      withCapLink(null, HOST, OFFERED, SOURCE),
      'power-meter',
      'meter-device',
    )
    const gone: CapLinkView = {
      linkId: 'meter-device',
      cap: 'power-meter',
      slot: null,
      mode: 'project',
      source: { deviceId: null, cap: 'power-meter' },
      state: 'source-gone',
    }
    expect(capLinkCellState(null, [gone], OFFERED)).toBe('unlinked')
    expect(capLinkCellState(stored, [gone], OFFERED)).toBe('source-gone')
    expect(capLinkCellState(stored, null, OFFERED)).toBe('linked')
  })
})
