import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  findOnboardedMatch,
  mapReolinkDiscoveryToCandidates,
  type OnboardedReolinkDevice,
  type ReolinkDiscoveredHost,
  slugifyReolinkHost,
} from '../reolink-discovery-map.js'

describe('slugifyReolinkHost', () => {
  it('flattens an IP / hostname into a dashed slug', () => {
    expect(slugifyReolinkHost('192.168.10.50')).toBe('192-168-10-50')
    expect(slugifyReolinkHost('Cam-Front.local')).toBe('cam-front-local')
  })
  it('trims leading / trailing separators', () => {
    expect(slugifyReolinkHost('  .192.168.10.50.  ')).toBe('192-168-10-50')
  })
})

describe('mapReolinkDiscoveryToCandidates', () => {
  const cam = (
    over: Partial<ReolinkDiscoveredHost> & Pick<ReolinkDiscoveredHost, 'host'>,
  ): ReolinkDiscoveredHost => over

  it('maps a discovered camera to a Camera candidate with a host-keyed stableId', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates(
      [cam({ host: '192.168.10.50', model: 'RLC-810A', name: 'Front Door', httpPort: 8000 })],
      {},
    )
    expect(candidate).toEqual({
      stableId: 'host-192-168-10-50',
      type: DeviceType.Camera,
      suggestedName: 'Front Door',
      prefilledConfig: {
        name: 'Front Door',
        host: '192.168.10.50',
        transport: 'auto',
      },
    })
  })

  /**
   * REGRESSION. `port` is the BAICHUAN port (schema default 9000); `httpPort` is the
   * HTTP/ONVIF listener. On a Reolink Home Hub those are 9000 and 8000 respectively.
   * Carrying the scan's `httpPort` into `port` pointed every Baichuan login at the ONVIF
   * listener, which accepts the connection and closes it — `Baichuan socket closed`, 316
   * times in 12 hours, with the hub and its three child cameras offline throughout.
   *
   * This asserted the BUG before 2026-09-04: the suite was green on `port: 8000`.
   */
  it('never derives the Baichuan port from the scan, whatever httpPort the device reports', () => {
    for (const httpPort of [80, 8000, 8080]) {
      const [candidate] = mapReolinkDiscoveryToCandidates(
        [cam({ host: '192.168.10.161', name: 'Reolink Home Hub', httpPort })],
        {},
      )
      expect(candidate?.prefilledConfig).not.toHaveProperty('port')
    }
  })

  it('marks a candidate the provider already owns instead of offering it again', () => {
    const onboarded: readonly OnboardedReolinkDevice[] = [
      { deviceId: 639, name: 'ReolinkHomeHub', host: '192.168.10.161' },
    ]
    const [candidate] = mapReolinkDiscoveryToCandidates(
      [cam({ host: '192.168.10.161', name: 'Reolink Home Hub', httpPort: 8000 })],
      {},
      onboarded,
    )
    expect(candidate?.alreadyOnboarded).toBe(true)
    expect(candidate?.onboardedDeviceId).toBe(639)
    expect(candidate?.onboardedName).toBe('ReolinkHomeHub')
  })

  it('leaves a genuinely new host unmarked — absent is not "known to be new"', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates([cam({ host: '192.168.10.77' })], {}, [
      { deviceId: 639, name: 'ReolinkHomeHub', host: '192.168.10.161' },
    ])
    expect(candidate?.alreadyOnboarded).toBeUndefined()
    expect(candidate?.onboardedDeviceId).toBeUndefined()
  })

  it('prefers name, then model, then host for the display name', () => {
    const [byModel] = mapReolinkDiscoveryToCandidates(
      [cam({ host: '10.0.0.2', model: 'RLC-520' })],
      {},
    )
    expect(byModel?.suggestedName).toBe('RLC-520')
    const [byHost] = mapReolinkDiscoveryToCandidates([cam({ host: '10.0.0.3' })], {})
    expect(byHost?.suggestedName).toBe('10.0.0.3')
  })

  it('threads scan-form credentials + uid into prefilledConfig for a one-click adopt', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates(
      [cam({ host: '10.0.0.4', uid: 'ABC123' })],
      { username: 'admin', password: 'secret' },
    )
    expect(candidate?.prefilledConfig).toMatchObject({
      host: '10.0.0.4',
      transport: 'auto',
      uid: 'ABC123',
      username: 'admin',
      password: 'secret',
    })
  })

  it('omits credentials when the scan form left them blank', () => {
    const [candidate] = mapReolinkDiscoveryToCandidates([cam({ host: '10.0.0.5' })], {
      username: '',
      password: '',
    })
    expect(candidate?.prefilledConfig).not.toHaveProperty('username')
    expect(candidate?.prefilledConfig).not.toHaveProperty('password')
  })

  it('de-duplicates cameras that answer on more than one discovery method (first host wins)', () => {
    const candidates = mapReolinkDiscoveryToCandidates(
      [
        cam({ host: '192.168.10.50', name: 'via UDP', model: 'RLC-810A' }),
        cam({ host: '192.168.10.50', name: 'via ONVIF', model: 'RLC-810A' }),
        cam({ host: '192.168.10.51', name: 'other' }),
      ],
      {},
    )
    expect(candidates).toHaveLength(2)
    expect(candidates[0]?.suggestedName).toBe('via UDP')
    expect(candidates.map((c) => c.stableId)).toEqual(['host-192-168-10-50', 'host-192-168-10-51'])
  })
})

describe('findOnboardedMatch', () => {
  const onboarded: readonly OnboardedReolinkDevice[] = [
    { deviceId: 10, name: 'Moved cam', host: '192.168.10.50', uid: 'UID-A' },
    { deviceId: 11, name: 'Host only', host: '192.168.10.51' },
  ]

  it('matches on UID even when the address moved — the address is the thing that changes', () => {
    const m = findOnboardedMatch({ host: '192.168.10.99', uid: 'UID-A' }, onboarded)
    expect(m?.deviceId).toBe(10)
  })

  it('falls back to host when the scan reported no UID', () => {
    expect(findOnboardedMatch({ host: '192.168.10.51' }, onboarded)?.deviceId).toBe(11)
  })

  it('does not match an empty UID against a device that has none', () => {
    expect(findOnboardedMatch({ host: '10.0.0.9', uid: '' }, onboarded)).toBeUndefined()
  })
})
