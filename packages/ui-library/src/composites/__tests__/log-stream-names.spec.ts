/**
 * The friendly names of the log table's integration and device columns come
 * from two lists read once; an id the lists do not know shows as itself.
 */
import { describe, expect, it } from 'vitest'
import {
  addonNameIndex,
  deviceNameIndex,
  entryAddonId,
  entryDeviceId,
  nameOrId,
} from '../log-stream-names'

const entry = (over: { scope?: string; tags?: Record<string, string> }) => ({
  timestamp: '2026-11-16T10:00:00.000Z',
  level: 'info',
  message: 'm',
  ...over,
})

describe('addonNameIndex', () => {
  it("prefers the addon's name, then the package's, then the id", () => {
    const index = addonNameIndex([
      { manifest: { id: 'recorder', name: 'Recorder', packageDisplayName: 'Pkg' } },
      { manifest: { id: 'provider-onvif', packageDisplayName: 'ONVIF' } },
      { manifest: { id: 'bare' } },
      { nothing: true },
    ])
    expect(index.get('recorder')).toBe('Recorder')
    expect(index.get('provider-onvif')).toBe('ONVIF')
    expect(index.get('bare')).toBe('bare')
    expect(index.size).toBe(3)
  })
})

describe('deviceNameIndex', () => {
  it('uses the operator label, else the name, keyed by the tag spelling', () => {
    const index = deviceNameIndex([
      { id: 101, name: 'cam-101', display: { label: ' Driveway ' } },
      { id: 102, name: 'Garage' },
      { id: 103, name: '' },
    ])
    expect(index.get('101')).toBe('Driveway')
    expect(index.get('102')).toBe('Garage')
    expect(index.has('103')).toBe(false)
  })
})

describe('what a line points at', () => {
  it('the addon is the tag, else the addon scope; the device is the tag', () => {
    expect(entryAddonId(entry({ tags: { addonId: 'recorder' }, scope: 'hub' }))).toBe('recorder')
    expect(entryAddonId(entry({ scope: 'addon:notifier-mail' }))).toBe('notifier-mail')
    expect(entryAddonId(entry({ scope: 'hub' }))).toBeNull()
    expect(entryDeviceId(entry({ tags: { deviceId: '101' } }))).toBe('101')
    expect(entryDeviceId(entry({}))).toBeNull()
  })
})

describe('nameOrId', () => {
  it('falls back to the id when the list is unanswered or does not know it', () => {
    expect(nameOrId(null, '101')).toBe('101')
    expect(nameOrId(new Map([['5', 'Hall']]), '101')).toBe('101')
    expect(nameOrId(new Map([['101', 'Driveway']]), '101')).toBe('Driveway')
  })
})
