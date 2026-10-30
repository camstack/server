import type { DiscoveryHit } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const getDeviceInfo = vi.fn()
vi.mock('../amcrest-cgi-client.js', () => ({
  AmcrestCgiClient: class {
    getDeviceInfo = getDeviceInfo
  },
}))

const { AMCREST_DISCOVERY_MODES, amcrestFromHttpHits, amcrestFromWsdHits } = await import(
  '../amcrest-discovery.js'
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

describe('Amcrest discovery classification', () => {
  it('declares ws-discovery plus a CGI http-probe', () => {
    expect(AMCREST_DISCOVERY_MODES.map((m) => m.kind)).toEqual(['ws-discovery', 'http-probe'])
  })

  it('keeps a WS-Discovery responder that names the vendor and rejects another', () => {
    const cams = amcrestFromWsdHits([
      wsd('192.0.2.10', [
        'onvif://www.onvif.org/name/Dahua%20IPC',
        'onvif://www.onvif.org/hardware/IPC-1',
      ]),
      wsd('192.0.2.11', ['onvif://www.onvif.org/name/OtherCam']),
    ])
    expect(cams).toEqual([{ host: '192.0.2.10', port: 8000, name: 'Dahua IPC', model: 'IPC-1' }])
  })

  it('confirms a CGI hit with credentials, only for a real deviceInfo', async () => {
    getDeviceInfo.mockImplementation(async function (this: unknown) {
      return getDeviceInfo.mock.calls.length === 1
        ? { deviceType: 'IP2M', serialNumber: 'SN1' }
        : { deviceType: null, serialNumber: null }
    })
    const cams = await amcrestFromHttpHits([httpHit('192.0.2.20'), httpHit('192.0.2.21')], {
      username: 'admin',
      password: 'secret',
    })
    expect(cams).toEqual([{ host: '192.0.2.20', port: 80, name: 'IP2M', model: 'IP2M' }])
  })

  it('never calls a host without credentials', async () => {
    expect(await amcrestFromHttpHits([httpHit('192.0.2.20')], null)).toEqual([])
    expect(getDeviceInfo).not.toHaveBeenCalled()
  })
})
