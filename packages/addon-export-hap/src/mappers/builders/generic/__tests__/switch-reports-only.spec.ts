/**
 * D1058: a switch that ANSWERED `getOptions().supportsSetState: false` (a PoE
 * port seen only through an API key) publishes no HomeKit Switch — every write
 * would fail — and a device with nothing else exportable gets no Export tab.
 * No `getOptions`, or a failed read, keeps the switch (D315).
 */
import { describe, expect, it } from 'vitest'
import { exportableCaps, rowsForCaps } from '../cap-service-table.js'

const PORT = new Set(['switch'])

describe('HomeKit — a switch that only reports (D1058)', () => {
  it('drops the switch it ANSWERED cannot be set, so the port maps to no row', async () => {
    const result = await exportableCaps(PORT, async () => ({
      supportsSetState: false,
      supportsPowerCycle: true,
    }))
    expect([...result.capNames]).toEqual([])
    expect(result.switchOptions).toEqual({ kind: 'answered', refusesSetState: true })
    expect(rowsForCaps(result.capNames)).toHaveLength(0)
  })

  it('keeps a settable switch', async () => {
    const result = await exportableCaps(PORT, async () => ({
      supportsSetState: true,
      supportsPowerCycle: false,
    }))
    expect(rowsForCaps(result.capNames).map((r) => r.label)).toEqual(['Power'])
  })

  it('keeps the switch when the read failed or the provider has no getOptions', async () => {
    const failed = await exportableCaps(PORT, () => Promise.reject(new Error('timeout')))
    expect([...failed.capNames]).toEqual(['switch'])
    expect(failed.switchOptions.kind).toBe('failed')
    const absent = await exportableCaps(PORT, async () => undefined)
    expect([...absent.capNames]).toEqual(['switch'])
  })

  it('does not read a device that binds no switch', async () => {
    let reads = 0
    const result = await exportableCaps(new Set(['contact']), async () => {
      reads += 1
      return {}
    })
    expect(reads).toBe(0)
    expect(result.switchOptions).toEqual({ kind: 'not-bound' })
  })
})
