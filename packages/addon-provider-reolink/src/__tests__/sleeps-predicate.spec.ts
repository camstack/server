import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeviceFeature } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { deriveReolinkCameraFeatures, reolinkCameraSleeps } from '../device-features.js'

/**
 * #459 Q2: a Reolink camera that publishes `Sleeps` in its stream catalog must
 * also be one the registry can WAKE — the registry derives `Sleeps` from the
 * `low-power-sleep` binding. The features and the registration used to read
 * different predicates (`probe.hasBattery || isBattery` vs `isBattery`), so a
 * hub child whose probe found a battery claimed `Sleeps` with no binding.
 *
 * The predicate is checked behaviourally; its wiring structurally, as the
 * sibling `intercom-retroactive-registration.spec.ts` does, because
 * constructing a `ReolinkCamera` needs the whole `DeviceContext`.
 */
const inputs = [
  { probe: {}, isBattery: false },
  { probe: {}, isBattery: true },
  { probe: { hasBattery: true }, isBattery: false },
  { probe: { hasBattery: true }, isBattery: true },
] as const

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function body(marker: string, endMarker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const end = source.indexOf(endMarker, start + marker.length)
  if (end === -1) throw new Error(`end marker not found: ${endMarker}`)
  return source.slice(start, end)
}

describe('reolinkCameraSleeps — one predicate for the feature and the binding', () => {
  it.each(inputs)('agrees with the published Sleeps feature (%o)', (i) => {
    expect(reolinkCameraSleeps(i)).toBe(
      deriveReolinkCameraFeatures(i).includes(DeviceFeature.Sleeps),
    )
  })

  it('a probe-found battery is a sleeper even before the driver flag is set', () => {
    expect(reolinkCameraSleeps({ probe: { hasBattery: true }, isBattery: false })).toBe(true)
  })

  it('a camera with no battery evidence is not a sleeper', () => {
    expect(reolinkCameraSleeps({ probe: {}, isBattery: false })).toBe(false)
  })
})

describe('the battery / low-power-sleep registration reads the same predicate', () => {
  const register = body('private registerBatteryIfSupported(): void {', '\n  }\n')

  it('gates on reolinkCameraSleeps, not on isBattery alone', () => {
    expect(register).toContain('if (!reolinkCameraSleeps(this.featureInputs())) return')
    expect(register).not.toContain('if (!this.isBattery) return')
  })

  it('registers the low-power-sleep cap', () => {
    expect(register).toContain('this.ctx.registerNativeCap(lowPowerSleepCapability, sleepProvider)')
  })

  it('writes the low-power-sleep slice from every battery write, and seeds it', () => {
    expect(register).toContain(
      'this.setCapSlice(lowPowerSleepCapability, sleepSliceOfBattery(slice))',
    )
    expect(register).toContain(
      'this.setCapSlice(lowPowerSleepCapability, sleepSliceOfBattery(this.state.battery))',
    )
  })

  it('is re-run after a feature probe, so a probe-found battery gets its binding', () => {
    const retro = body(
      'Now that features are known, register optional caps retroactively',
      'Reolink features probed + persisted',
    )
    expect(retro).toContain('this.registerBatteryIfSupported()')
  })
})
