import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccessoryKind } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { accessoryKindsFor, withPersistedProbe } from '../accessory-probe-flags'
import { reolinkCameraSchema } from '../schema'

/**
 * A battery camera that is asleep at boot skips its probe, and the
 * `feature-probe` slice is session-only — so its Siren / Floodlight / PIR
 * children only exist after a restart if the LAST successful probe was
 * persisted to `deviceCache` (`probedAt` + the `has*` flags). Nothing wrote
 * those any more, so the fallback in `accessory-probe-flags.ts` was dead and
 * the children vanished until the camera woke up on its own.
 */

const PROBED = {
  hasBattery: true,
  hasSiren: true,
  hasFloodlight: true,
  hasPirSensor: true,
  hasPtz: false,
}

/** What the per-device store hands back on the next boot. */
function restored(blob: unknown): Record<string, unknown> {
  const parsed = reolinkCameraSchema.shape.deviceCache.parse(blob)
  if (parsed === undefined) throw new Error('deviceCache dropped')
  return parsed as Record<string, unknown>
}

describe('a probe persists its accessory flags into deviceCache', () => {
  it('stamps probedAt and writes every boolean flag, keeping the existing fields', () => {
    const previous = { deviceType: 'battery-cam', model: 'Argus 3 Pro', channelCount: 1 }
    const next = withPersistedProbe(previous, PROBED, 1_760_000_000_000)
    expect(next).toEqual({
      deviceType: 'battery-cam',
      model: 'Argus 3 Pro',
      channelCount: 1,
      probedAt: 1_760_000_000_000,
      hasBattery: true,
      hasSiren: true,
      hasFloodlight: true,
      hasPirSensor: true,
      hasPtz: false,
    })
    expect(previous).not.toHaveProperty('probedAt')
  })

  it('a later probe that reports a flag false overwrites the persisted true', () => {
    const first = withPersistedProbe({}, PROBED, 1)
    const second = withPersistedProbe(first, { ...PROBED, hasSiren: false }, 2)
    expect(second.hasSiren).toBe(false)
    expect(second.probedAt).toBe(2)
  })

  it('probeAndPersistFeatures writes the probe through withPersistedProbe', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')
    const start = source.indexOf('private async probeAndPersistFeatures(')
    const end = source.indexOf('Reolink features probed + persisted', start)
    expect(start).toBeGreaterThan(-1)
    expect(source.slice(start, end)).toMatch(/withPersistedProbe\(/)
  })
})

describe('restart with a sleeping camera (empty feature-probe slice)', () => {
  it('returns the accessory children from the persisted flags', () => {
    const blob = restored(withPersistedProbe({ deviceType: 'battery-cam' }, PROBED, 42))
    expect(accessoryKindsFor(false, {}, blob)).toEqual([
      AccessoryKind.Siren,
      AccessoryKind.Floodlight,
      AccessoryKind.PirSensor,
    ])
  })

  it('returns only the accessories the camera actually has', () => {
    const blob = restored(
      withPersistedProbe({}, { hasSiren: true, hasFloodlight: false, hasPirSensor: true }, 42),
    )
    expect(accessoryKindsFor(false, {}, blob)).toEqual([
      AccessoryKind.Siren,
      AccessoryKind.PirSensor,
    ])
  })

  it('the live slice still wins once the camera has probed this session', () => {
    const blob = restored(withPersistedProbe({}, PROBED, 42))
    expect(accessoryKindsFor(true, { hasSiren: true }, blob)).toEqual([AccessoryKind.Siren])
  })
})

describe('a camera that never probed', () => {
  it('returns no accessory children', () => {
    expect(accessoryKindsFor(false, {}, undefined)).toEqual([])
    expect(accessoryKindsFor(false, {}, restored({ deviceType: 'battery-cam' }))).toEqual([])
  })

  it('discovery-time flags without a probe stamp do not count', () => {
    expect(accessoryKindsFor(false, {}, restored({ hasSiren: true }))).toEqual([])
  })
})

describe('a camera asleep at boot probes on its first natural wake', () => {
  // `onProbe` skips a sleeping battery camera and promises the probe is
  // "re-run for free by onWakeTransition" — but nothing there ran it, and a
  // hub child never logs in on its own, so its flags could never be
  // persisted. The first wake of the session must run the kernel reprobe
  // (probe + accessory reconcile), once.
  const here = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')
  const start = source.indexOf('private async onWakeTransition(')
  const end = source.indexOf('\n  }\n', start)
  const body = source.slice(start, end)

  it('runs reprobe() when this session has not probed yet', () => {
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/if \(!this\.hasProbed\(\)\)[\s\S]{0,200}this\.reprobe\(\)/)
  })
})
