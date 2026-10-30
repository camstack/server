import type { DiscoveryHit } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDeviceInfo = vi.fn()
vi.mock('../hikvision-isapi-client.js', () => ({
  HikvisionIsapiClient: class {
    getDeviceInfo = getDeviceInfo
  },
}))

const { HIKVISION_DISCOVERY_MODES, hikvisionFromHttpHits, hikvisionFromWsdHits } = await import(
  '../hikvision-discovery.js'
)

afterEach(() => getDeviceInfo.mockReset())

function wsd(host: string, scopes: string[]): DiscoveryHit {
  return {
    host,
    port: 3702,
    modeIndex: 0,
    wsd: { xaddrs: [`http://${host}:8000/onvif/device_service`], types: [], scopes },
  }
}
const httpHit = (host: string): DiscoveryHit => ({
  host,
  port: 80,
  modeIndex: 1,
  http: { status: 401, headers: {}, bodyText: '' },
})

describe('Hikvision discovery classification', () => {
  it('declares ws-discovery plus an ISAPI http-probe', () => {
    expect(HIKVISION_DISCOVERY_MODES.map((m) => m.kind)).toEqual(['ws-discovery', 'http-probe'])
  })

  it('keeps a WS-Discovery responder that names the vendor and rejects another', () => {
    const cams = hikvisionFromWsdHits([
      wsd('192.0.2.10', [
        'onvif://www.onvif.org/name/HIKVISION%20DS-2CD',
        'onvif://www.onvif.org/hardware/DS-2CD',
      ]),
      wsd('192.0.2.11', ['onvif://www.onvif.org/name/OtherCam']),
    ])
    expect(cams).toEqual([
      { host: '192.0.2.10', port: 8000, name: 'HIKVISION DS-2CD', model: 'DS-2CD' },
    ])
  })

  it('confirms an ISAPI hit with credentials, only for a real deviceInfo', async () => {
    getDeviceInfo.mockImplementation(async function (this: unknown) {
      return getDeviceInfo.mock.calls.length === 1
        ? { model: 'DS-1', serialNumber: 'SN1' }
        : { model: null, serialNumber: null }
    })
    const cams = await hikvisionFromHttpHits([httpHit('192.0.2.20'), httpHit('192.0.2.21')], {
      username: 'admin',
      password: 'secret',
    })
    expect(cams).toEqual([{ host: '192.0.2.20', port: 80, name: 'DS-1', model: 'DS-1' }])
  })

  it('never calls a host without credentials', async () => {
    expect(await hikvisionFromHttpHits([httpHit('192.0.2.20')], null)).toEqual([])
    expect(getDeviceInfo).not.toHaveBeenCalled()
  })
})
