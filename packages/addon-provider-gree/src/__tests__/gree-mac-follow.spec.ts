import { describe, expect, it } from 'vitest'
import { mergeConnectionPatch, settingsToGreeConfig } from '../config.js'
import { buildGreeProposals } from '../gree-discovery.js'
import { planMacFollow } from '../gree-mac-follow.js'

describe('planMacFollow', () => {
  const known = [{ deviceId: 7, mac: 'aa:bb:cc:dd:ee:01', host: '192.0.2.10' }]

  it('moves an adopted AC whose MAC answers from a new address, keeping its device id', () => {
    const moves = planMacFollow([{ mac: 'AA:BB:CC:DD:EE:01', ip: '198.51.100.20' }], known)
    expect(moves).toEqual([
      {
        deviceId: 7,
        mac: 'aa:bb:cc:dd:ee:01',
        oldIp: '192.0.2.10',
        newIp: '198.51.100.20',
      },
    ])
  })

  it('leaves an AC that answers from its own address and ignores unknown MACs', () => {
    expect(planMacFollow([{ mac: 'aa:bb:cc:dd:ee:01', ip: '192.0.2.10' }], known)).toEqual([])
    expect(planMacFollow([{ mac: 'ff:ff:ff:ff:ff:ff', ip: '198.51.100.99' }], known)).toEqual([])
  })
})

describe('mergeConnectionPatch', () => {
  const current = settingsToGreeConfig({
    host: '192.0.2.10',
    timeoutMs: 4000,
    retries: 5,
  })

  it('changes only the host from the settings form and keeps the UDP tuning', () => {
    const next = mergeConnectionPatch(current, { host: ' 198.51.100.20 ' })
    expect(next).toMatchObject({
      host: '198.51.100.20',
      timeoutMs: 4000,
      retries: 5,
    })
  })

  it('accepts a whole connection blob and the broadcast field', () => {
    expect(
      mergeConnectionPatch(current, {
        connection: { ...current, host: '198.51.100.21' },
      })?.host,
    ).toBe('198.51.100.21')
    expect(mergeConnectionPatch(current, { broadcastAddr: '198.51.100.255' })?.broadcastAddr).toBe(
      '198.51.100.255',
    )
  })

  it('ignores a patch that touches no connection field', () => {
    expect(mergeConnectionPatch(current, { enabledModes: [] })).toBeNull()
  })
})

describe('buildGreeProposals', () => {
  it('proposes an AC found on a routed subnet with the IP it answered from', () => {
    const [candidate] = buildGreeProposals(
      [
        {
          mac: 'AA:BB:CC:DD:EE:02',
          ip: '198.51.100.20',
          name: 'Bedroom',
          model: 'x',
        },
      ],
      new Map(),
    )
    expect(candidate?.stableId).toBe('gree:aa:bb:cc:dd:ee:02')
    expect(candidate?.prefilledConfig).toMatchObject({
      host: '198.51.100.20',
      name: 'Bedroom',
    })
    expect(candidate?.alreadyOnboarded).toBeUndefined()
  })

  it('recognises an owned AC by MAC', () => {
    const [candidate] = buildGreeProposals(
      [{ mac: 'AA:BB:CC:DD:EE:01', ip: '198.51.100.20', name: '' }],
      new Map([['aa:bb:cc:dd:ee:01', { deviceId: 7, name: 'Daniel' }]]),
    )
    expect(candidate).toMatchObject({
      alreadyOnboarded: true,
      onboardedDeviceId: 7,
    })
  })
})
