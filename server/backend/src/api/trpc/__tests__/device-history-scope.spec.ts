/**
 * `device-history` reads name a device in a FLAT top-level `deviceId`, so the
 * generated device selector — and the scope gate that reads it — sees them. A
 * nested `subject.deviceId` would have let a principal limited to device 5 read
 * the history of device 9 (the gate only walks top-level ids).
 *
 * Neutralisation: put the id back under `subject` and the "not 9" assertions flip
 * to `ok: true`.
 */
import type { TokenScope } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../scope-access.js'

const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: () => DeviceType.Sensor,
  getLocation: () => null,
}

const systemView: TokenScope = { type: 'category', target: 'system', access: ['view'] }
const deviceFive: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [5] },
  access: ['view'],
}

const window = { key: 'cap:battery.level', from: 0, to: 1 }

describe('device-history reads honour device scope', () => {
  for (const [method, input] of [
    ['deviceHistory.query', (deviceId: number) => ({ deviceId, ...window })],
    ['deviceHistory.listSeries', (deviceId: number) => ({ deviceId })],
    ['deviceHistory.getDeviceEnabled', (deviceId: number) => ({ deviceId })],
  ] as const) {
    it(`${method}: a principal limited to device 5 reads 5 but not 9`, () => {
      const scopes = [systemView, deviceFive]
      expect(checkScopeAccess(scopes, method, input(5), lookup).ok).toBe(true)
      expect(checkScopeAccess(scopes, method, input(9), lookup).ok).toBe(false)
    })
  }

  it('category:system alone does not reach any single device', () => {
    expect(
      checkScopeAccess([systemView], 'deviceHistory.query', { deviceId: 9, ...window }, lookup).ok,
    ).toBe(false)
  })

  it('control: the gate acts only through the selector, so a nested id would escape it', () => {
    // `queryNode` carries no device reference; a nested `subject.deviceId` is the same to the gate.
    const scopes = [systemView, deviceFive]
    expect(
      checkScopeAccess(
        scopes,
        'deviceHistory.queryNode',
        { subject: { deviceId: 9 }, ...window },
        lookup,
      ).ok,
    ).toBe(true)
  })
})
