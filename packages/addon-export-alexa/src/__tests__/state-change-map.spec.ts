/**
 * R3 — a device's state change, mapped to the Alexa properties it changes on
 * the endpoints this addon published.
 */
import { describe, expect, it } from 'vitest'
import { stateReportsFor } from '../state-reports/state-change-map.js'

const EXPORTED = {
  10: ['10', '10__privacy', '10__autotrack', '10__11', '10__det_person'],
  30: ['30__alarm'],
}

describe('stateReportsFor', () => {
  it('an alarm panel change reports armState and burglaryAlarm', () => {
    expect(
      stateReportsFor(
        { deviceId: 30, capName: 'alarm-panel', slice: { state: 'triggered' } },
        EXPORTED,
      ),
    ).toEqual({
      kind: 'reports',
      reports: [
        {
          exposedDeviceId: 30,
          endpointId: '30__alarm',
          interfaceName: 'Alexa.SecurityPanelController',
          properties: [
            // A triggered panel with no remembered mode reads as armed away
            // (`alexaArmStateFor`), never as disarmed.
            { namespace: 'Alexa.SecurityPanelController', name: 'armState', value: 'ARMED_AWAY' },
            {
              namespace: 'Alexa.SecurityPanelController',
              name: 'burglaryAlarm',
              value: { value: 'ALARM' },
            },
          ],
        },
      ],
    })
  })

  it('privacy and autotrack report on their own switch endpoints', () => {
    const privacy = stateReportsFor(
      { deviceId: 10, capName: 'privacy-mask', slice: { enabled: true } },
      EXPORTED,
    )
    expect(
      privacy?.kind === 'reports'
        ? privacy.reports.map((r) => [r.endpointId, r.properties[0]?.value])
        : null,
    ).toEqual([['10__privacy', 'ON']])
    const auto = stateReportsFor(
      { deviceId: 10, capName: 'ptz-autotrack', slice: { enabled: false } },
      EXPORTED,
    )
    expect(auto?.kind === 'reports' ? auto.reports[0]?.endpointId : null).toBe('10__autotrack')
  })

  it('an accessory reports on the parent__child endpoint', () => {
    const sw = stateReportsFor({ deviceId: 11, capName: 'switch', slice: { on: true } }, EXPORTED)
    expect(sw?.kind === 'reports' ? sw.reports[0] : null).toMatchObject({
      exposedDeviceId: 10,
      endpointId: '10__11',
      properties: [{ name: 'powerState', value: 'ON' }],
    })
    const br = stateReportsFor(
      { deviceId: 11, capName: 'brightness', slice: { percentage: 41.6 } },
      EXPORTED,
    )
    expect(br?.kind === 'reports' ? br.reports[0]?.properties[0]?.value : null).toBe(42)
  })

  it('device-status becomes a connectivity change', () => {
    expect(
      stateReportsFor(
        { deviceId: 10, capName: 'device-status', slice: { online: false } },
        EXPORTED,
      ),
    ).toEqual({
      kind: 'connectivity',
      deviceId: 10,
      online: false,
    })
  })

  it('nothing for a device or cap this addon did not publish, or a malformed slice', () => {
    expect(
      stateReportsFor({ deviceId: 99, capName: 'switch', slice: { on: true } }, EXPORTED),
    ).toBeNull()
    expect(
      stateReportsFor({ deviceId: 10, capName: 'motion', slice: { detected: true } }, EXPORTED),
    ).toBeNull()
    expect(
      stateReportsFor({ deviceId: 11, capName: 'switch', slice: { on: 'yes' } }, EXPORTED),
    ).toBeNull()
  })
})
