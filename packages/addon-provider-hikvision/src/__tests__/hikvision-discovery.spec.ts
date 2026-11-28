import type { DiscoveryHit } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OnboardedHikvisionCamera } from '../hikvision-discovery.js'

const getDeviceInfo = vi.fn()
vi.mock('../hikvision-isapi-client.js', () => ({
  HikvisionIsapiClient: class {
    getDeviceInfo = getDeviceInfo
  },
}))

const {
  HIKVISION_DISCOVERY_MODES,
  findOnboardedHikvisionMatch,
  hikvisionFromHttpHits,
  hikvisionFromWsdHits,
  mapHikvisionDiscoveryToCandidates,
} = await import('../hikvision-discovery.js')

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

describe('findOnboardedHikvisionMatch', () => {
  const onboarded: readonly OnboardedHikvisionCamera[] = [
    { deviceId: 42, name: 'Front Door', host: 'Cam-Front.LOCAL' },
  ]

  it('matches a stored host case/format-insensitively', () => {
    expect(findOnboardedHikvisionMatch('cam-front.local', onboarded)?.deviceId).toBe(42)
  })

  it('leaves a genuinely new host unmarked', () => {
    expect(findOnboardedHikvisionMatch('192.0.2.99', onboarded)).toBeUndefined()
  })
})

describe('mapHikvisionDiscoveryToCandidates', () => {
  /**
   * REGRESSION (#541). A camera adopted through this provider persists `mac-<mac>` — the
   * MAC is learned by a separate network probe `onCreateDevice` runs at creation time, which
   * discovery never does (it only confirms `deviceInfo`: model + serial). A re-scan of that
   * same camera therefore always classifies it under `host-<slug>`, a stableId that can never
   * equal the stored `mac-<mac>` one — a stableId-only comparison re-offers it forever. The
   * fix marks it `alreadyOnboarded` by host instead, the identity discovery CAN reproduce.
   */
  it('marks a MAC-keyed camera already owned instead of offering it again', () => {
    const onboarded: readonly OnboardedHikvisionCamera[] = [
      { deviceId: 7, name: 'Front Door', host: '192.0.2.50' },
    ]
    const [candidate] = mapHikvisionDiscoveryToCandidates(
      [{ host: '192.0.2.50', port: 80, model: 'DS-2CD' }],
      {},
      onboarded,
    )
    expect(candidate?.alreadyOnboarded).toBe(true)
    expect(candidate?.onboardedDeviceId).toBe(7)
    expect(candidate?.onboardedName).toBe('Front Door')
  })

  it('leaves a genuinely new host unmarked — absent is not "known to be new"', () => {
    const [candidate] = mapHikvisionDiscoveryToCandidates([{ host: '192.0.2.77', port: 80 }], {}, [
      { deviceId: 7, name: 'Front Door', host: '192.0.2.50' },
    ])
    expect(candidate?.alreadyOnboarded).toBeUndefined()
    expect(candidate?.onboardedDeviceId).toBeUndefined()
  })
})
