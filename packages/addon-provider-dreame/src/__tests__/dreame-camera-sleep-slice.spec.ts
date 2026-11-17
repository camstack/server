import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LowPowerSleepStatusSchema, sleepSliceOfBattery } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { cameraBatterySlice } from '../devices/dreame-camera-stream.js'

/**
 * #459 Q2: the robot's camera sleeps while its monitor is closed. The broker
 * and the recorder read that from the `low-power-sleep` slice, so every
 * battery write must also write the sleep projection. The projection is
 * checked behaviourally; the write structurally, because constructing a
 * `DreameCameraDevice` needs the whole `DeviceContext`.
 */
const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../devices/dreame-camera-device.ts'), 'utf8')

function publishBatteryBody(): string {
  const start = source.indexOf('private publishBattery(): void {')
  if (start === -1) throw new Error('publishBattery not found')
  return source.slice(start, source.indexOf('\n  }\n', start))
}

describe('dreame camera: low-power-sleep slice', () => {
  it('a closed monitor projects to a valid sleeping slice with the contact time', () => {
    const battery = cameraBatterySlice({
      level: 80,
      charging: 0,
      streamOpen: false,
      now: 5000,
      contactAt: 4000,
    })
    const sleep = sleepSliceOfBattery(battery)
    expect(LowPowerSleepStatusSchema.safeParse(sleep).success).toBe(true)
    expect(sleep).toMatchObject({ sleeping: true, lastContactAt: 4000 })
  })

  it('an open monitor is awake', () => {
    const battery = cameraBatterySlice({
      level: 80,
      charging: 0,
      streamOpen: true,
      now: 5000,
      contactAt: 4000,
    })
    expect(sleepSliceOfBattery(battery).sleeping).toBe(false)
  })

  it('publishBattery writes the sleep slice beside the battery slice', () => {
    const body = publishBatteryBody()
    expect(body).toContain('this.setCapSlice(batteryCapability, slice)')
    expect(body).toContain('this.setCapSlice(lowPowerSleepCapability, sleepSliceOfBattery(slice))')
  })
})
