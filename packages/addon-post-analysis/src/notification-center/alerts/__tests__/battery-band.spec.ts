/**
 * The BAND is the fact, not the percentage.
 *
 * Two failures are pinned here and both were measured on the live hub
 * (2026-09-01):
 *
 *  1. **Three devices read `percentage: 0` with `lastUpdated: 0`** — 3255
 *     (Sensore contatto finestra cameretta Dave), 3279 (Sensore contatto
 *     gazebo), 3609 (Termometro mansarda). That tuple is exactly the `battery`
 *     cap's declared `status.empty`. A gate written as `percentage <=
 *     threshold` announces a flat battery for three devices that have never
 *     reported one. `lastUpdated > 0` is the whole difference between "flat"
 *     and "unknown", and unknown is never news.
 *
 *  2. **A binary indicator has no percentage to compare.** The HA container
 *     maps `LOW_BAT` on→15 %, off→100 % (`ha-container-device.ts`), and the 15
 *     was chosen to sit under the conventional 20 % band so that consumers'
 *     alerting fires by coincidence. Nine devices on this fleet are binary and
 *     two of them (3560, 3581) read LOW right now. The coincidence breaks the
 *     moment the operator sets the threshold to 10: both would go silent and
 *     nothing would say why. A stand-in number is not a reading, so the
 *     operator's threshold is never applied to it.
 *
 * The hysteresis is the third property and it is what makes the RECOVERY
 * notification safe: a reading that oscillates one point around the threshold
 * must not produce alternating low/normal pairs. The band leaves `low` only
 * well clear of the edge.
 */
import { describe, expect, it } from 'vitest'
import {
  BATTERY_LOW_HYSTERESIS_PCT,
  deriveBatteryBand,
  type NcBatteryReading,
} from '../battery-band.js'

function numeric(percentage: number, lastUpdated = 1_000): NcBatteryReading {
  return { percentage, lastUpdated }
}

function binary(percentage: number, lastUpdated = 1_000): NcBatteryReading {
  return { percentage, lastUpdated, binary: true }
}

describe('deriveBatteryBand — a reading that never happened is not a reading', () => {
  it('answers null for lastUpdated 0, whatever the percentage says', () => {
    expect(deriveBatteryBand({ reading: numeric(0, 0), thresholdPercent: 20 })).toBeNull()
    expect(deriveBatteryBand({ reading: numeric(100, 0), thresholdPercent: 20 })).toBeNull()
  })

  it('answers null for a missing or negative clock', () => {
    expect(deriveBatteryBand({ reading: numeric(5, -1), thresholdPercent: 20 })).toBeNull()
  })

  it('answers null when the percentage is not a finite number', () => {
    const broken = { percentage: Number.NaN, lastUpdated: 1_000 }
    expect(deriveBatteryBand({ reading: broken, thresholdPercent: 20 })).toBeNull()
  })
})

describe('deriveBatteryBand — numeric', () => {
  it('is low at or below the threshold', () => {
    expect(deriveBatteryBand({ reading: numeric(20), thresholdPercent: 20 })).toBe('low')
    expect(deriveBatteryBand({ reading: numeric(19), thresholdPercent: 20 })).toBe('low')
  })

  it('is normal above the threshold', () => {
    expect(deriveBatteryBand({ reading: numeric(21), thresholdPercent: 20 })).toBe('normal')
  })

  it('honours the operator threshold, not a hardcoded 20', () => {
    expect(deriveBatteryBand({ reading: numeric(23), thresholdPercent: 30 })).toBe('low')
    expect(deriveBatteryBand({ reading: numeric(23), thresholdPercent: 10 })).toBe('normal')
  })
})

describe('deriveBatteryBand — binary indicators ignore the threshold', () => {
  it('reads the provider LOW stand-in as low even under a lower threshold', () => {
    // 3560 / 3581 today: binary, percentage 15. Threshold 10 would exclude a
    // numeric 15 — a binary one is still LOW, because 15 is not a measurement.
    expect(deriveBatteryBand({ reading: binary(15), thresholdPercent: 10 })).toBe('low')
  })

  it('reads the provider NORMAL stand-in as normal even under a higher threshold', () => {
    expect(deriveBatteryBand({ reading: binary(100), thresholdPercent: 100 })).toBe('normal')
  })

  it('still refuses a binary reading that never happened', () => {
    expect(deriveBatteryBand({ reading: binary(15, 0), thresholdPercent: 20 })).toBeNull()
  })
})

describe('deriveBatteryBand — hysteresis holds the band across an oscillation', () => {
  it('stays low while the reading wanders back over the bare threshold', () => {
    const at = (percentage: number) =>
      deriveBatteryBand({ reading: numeric(percentage), thresholdPercent: 20, previous: 'low' })
    expect(at(20)).toBe('low')
    expect(at(21)).toBe('low')
    expect(at(20 + BATTERY_LOW_HYSTERESIS_PCT - 1)).toBe('low')
  })

  it('leaves low only once the reading clears threshold + hysteresis', () => {
    expect(
      deriveBatteryBand({
        reading: numeric(20 + BATTERY_LOW_HYSTERESIS_PCT),
        thresholdPercent: 20,
        previous: 'low',
      }),
    ).toBe('normal')
  })

  it('does not apply hysteresis on the way DOWN — a fault is believed at once', () => {
    expect(
      deriveBatteryBand({ reading: numeric(20), thresholdPercent: 20, previous: 'normal' }),
    ).toBe('low')
  })

  it('never applies hysteresis to a binary indicator', () => {
    expect(deriveBatteryBand({ reading: binary(100), thresholdPercent: 20, previous: 'low' })).toBe(
      'normal',
    )
  })
})
