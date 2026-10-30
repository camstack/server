import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DeviceFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { effectiveProbeFlags, withPersistedProbe } from '../accessory-probe-flags'
import { deriveReolinkCameraFeatures } from '../device-features'
import { reolinkCameraSchema } from '../schema'

/**
 * PTZ / intercom / doorbell / autotrack are registered from the probe flags.
 * A battery camera asleep at boot skips its probe, so the session-only
 * `feature-probe` slice is empty and those caps vanished across every
 * provider restart — export-alexa then logged `ptz.getPresets failed … no
 * provider for "ptz"` and re-pushed a drifted endpoint shape. The flags of
 * the last successful probe are persisted in `deviceCache`; they must stand
 * in until this session probes.
 */

const PORTA_RETRO = {
  hasBattery: true,
  hasPtz: true,
  hasIntercom: true,
  hasDoorbell: false,
  hasAutotrack: true,
  hasSiren: true,
  hasFloodlight: true,
  hasPirSensor: true,
}

function restored(blob: unknown): Record<string, unknown> {
  const parsed = reolinkCameraSchema.shape.deviceCache.parse(blob)
  if (parsed === undefined) throw new Error('deviceCache dropped')
  return parsed as Record<string, unknown>
}

describe('effectiveProbeFlags', () => {
  it('restart while asleep: the persisted flags stand in for the empty slice', () => {
    const cache = restored(withPersistedProbe({ deviceType: 'camera' }, PORTA_RETRO, 42))
    expect(effectiveProbeFlags(false, {}, cache)).toMatchObject({
      hasPtz: true,
      hasIntercom: true,
      hasDoorbell: false,
      hasAutotrack: true,
    })
  })

  it('a probe this session wins over the persisted flags', () => {
    const cache = restored(withPersistedProbe({}, PORTA_RETRO, 42))
    expect(effectiveProbeFlags(true, { hasPtz: false }, cache)).toEqual({ hasPtz: false })
  })

  it('never probed: the slice is returned as is', () => {
    expect(effectiveProbeFlags(false, {}, undefined)).toEqual({})
    expect(effectiveProbeFlags(false, { hasBattery: true }, restored({ hasPtz: true }))).toEqual({
      hasBattery: true,
    })
  })

  it('the derived device features keep PTZ, autotrack and two-way audio while asleep', () => {
    const cache = restored(withPersistedProbe({}, PORTA_RETRO, 42))
    const features = deriveReolinkCameraFeatures({
      probe: effectiveProbeFlags(false, {}, cache),
      isBattery: true,
    })
    expect(features).toEqual(
      expect.arrayContaining([
        DeviceFeature.PanTiltZoom,
        DeviceFeature.PtzAutotrack,
        DeviceFeature.TwoWayAudio,
      ]),
    )
  })
})

describe('ReolinkCamera reads its probe flags through the persisted fallback', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

  it('overrides getProbeFlags with effectiveProbeFlags', () => {
    const start = source.indexOf('protected override getProbeFlags<')
    expect(start).toBeGreaterThan(-1)
    expect(source.slice(start, start + 600)).toMatch(/effectiveProbeFlags\(/)
  })

  it.each([
    'registerPtzIfSupported',
    'registerIntercomIfSupported',
    'registerDoorbellIfSupported',
    'registerPtzAutotrackIfSupported',
  ])('%s gates on getProbeFlags (so it sees the fallback)', (name) => {
    const start = source.indexOf(`private ${name}(): void {`)
    expect(start).toBeGreaterThan(-1)
    expect(source.slice(start, start + 1200)).toMatch(/this\.getProbeFlags<ReolinkProbeFlags>\(\)/)
  })
})
