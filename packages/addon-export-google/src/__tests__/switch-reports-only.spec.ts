/**
 * D1058: a switch that ANSWERED `getOptions().supportsSetState: false` (a PoE
 * port seen only through an API key) is not given an OnOff trait — every
 * EXECUTE would fail — and a device with nothing else is not exposable. No
 * `getOptions`, or a failed read, keeps the switch (D315).
 */
import type { LogExtras } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { exportedCapNames } from '../device-gateway.js'
import { traitsForCaps } from '../google-home/trait-catalog.js'

interface Line {
  readonly message: string
  readonly extras: LogExtras | undefined
}

function recorder(): {
  readonly lines: Line[]
  readonly debug: (m: string, e?: LogExtras) => void
} {
  const lines: Line[] = []
  return { lines, debug: (message, extras) => lines.push({ message, extras }) }
}

const PORT_ID = 33

describe('Google Home — a switch that only reports (D1058)', () => {
  it('drops a switch that ANSWERED it cannot be set: no OnOff trait, logged with the device', async () => {
    const log = recorder()
    const caps = await exportedCapNames(
      PORT_ID,
      ['switch'],
      async () => ({ supportsSetState: false, supportsPowerCycle: true }),
      log,
    )
    expect(caps).toEqual([])
    expect(traitsForCaps(caps)).toHaveLength(0)
    expect(log.lines[0]?.extras?.tags).toEqual({ deviceId: PORT_ID })
  })

  it('keeps a settable switch', async () => {
    const caps = await exportedCapNames(
      PORT_ID,
      ['switch'],
      async () => ({ supportsSetState: true, supportsPowerCycle: false }),
      recorder(),
    )
    expect(traitsForCaps(caps).map((t) => t.trait)).toEqual(['action.devices.traits.OnOff'])
  })

  it('a failed read keeps the switch and says so against the device', async () => {
    const log = recorder()
    const caps = await exportedCapNames(
      PORT_ID,
      ['switch'],
      () => Promise.reject(new Error('does not implement "getOptions"')),
      log,
    )
    expect(caps).toEqual(['switch'])
    expect(log.lines[0]?.extras?.tags).toEqual({ deviceId: PORT_ID })
  })
})
